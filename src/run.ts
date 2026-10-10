import * as core from "@actions/core";
import * as github from "@actions/github";
import Limrun from "@limrun/api/index.js";
import { statSync } from "node:fs";
import { postOrUpdateComment, updateCommentClosed } from "./comment.ts";

const cleanupState = "cleanup-label-selector";

function selector(labels: Record<string, string>): string {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",");
}

export function buildPreviewUrl(consoleUrl: string, assetName: string, openUrl: string, tunnel = ""): string {
  const url = new URL("preview", consoleUrl.endsWith("/") ? consoleUrl : `${consoleUrl}/`);
  url.searchParams.set("asset", assetName);
  url.searchParams.set("platform", "android");
  if (openUrl) url.searchParams.set("openUrl", openUrl);
  if (tunnel) url.searchParams.set("tunnel", tunnel);
  return url.toString();
}

/**
 * The persistent tunnel the preview emulator attaches to, or "". A malformed
 * name fails the run before the build, not when a reviewer opens the preview.
 */
function previewTunnel(): string {
  const value = core.getInput("tunnel").trim();
  if (value && (value.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value))) {
    throw new Error(
      `tunnel must be a persistent tunnel's name: lowercase letters, digits and dashes, at most 63 characters, got "${value}"`
    );
  }
  return value;
}

async function cleanup(client: Limrun, labelSelector: string): Promise<void> {
  const failures: unknown[] = [];
  for await (const instance of client.gradleInstances.list({
    labelSelector,
    state: "creating,assigned,ready,unknown",
  })) {
    try {
      core.info(`Deleting Gradle instance ${instance.metadata.id}...`);
      await client.gradleInstances.delete(instance.metadata.id);
    } catch (error) {
      core.warning(`Failed to delete Gradle instance ${instance.metadata.id}: ${error}`);
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Failed to clean up Gradle instances");
}

export async function runPost(): Promise<void> {
  const labelSelector = core.getState(cleanupState);
  if (!labelSelector) return;
  const apiKey = core.getInput("api-key", { required: true });
  core.setSecret(apiKey);
  await cleanup(new Limrun({ apiKey }), labelSelector);
}

export async function runMain(): Promise<void> {
  core.saveState("is-post-run", "true");
  const pr = github.context.payload.pull_request;
  if (github.context.eventName !== "pull_request" || !pr) {
    throw new Error("This action only works on pull_request events.");
  }
  const action = github.context.payload.action;
  if (!["opened", "synchronize", "reopened", "labeled", "closed"].includes(action ?? "")) {
    core.info(`Ignoring PR action ${action}.`);
    return;
  }

  const apiKey = core.getInput("api-key", { required: true });
  core.setSecret(apiKey);
  const githubToken = core.getInput("github-token");
  if (githubToken) core.setSecret(githubToken);
  const client = new Limrun({ apiKey });
  const { owner, repo } = github.context.repo;
  const prLabels = {
    managed_by: "android-preview-action",
    github_owner: owner,
    github_repo: repo,
    github_pr: String(pr.number),
    github_platform: "android",
  };
  const labels = {
    ...prLabels,
    github_run_id: String(github.context.runId),
    github_run_attempt: String(github.context.runAttempt),
  };
  // Run-specific labels keep a cancelled run's post hook from deleting a newer builder.
  const labelSelector = selector(action === "closed" ? prLabels : labels);
  core.saveState(cleanupState, labelSelector);

  if (action === "closed") {
    await cleanup(client, labelSelector);
    if (githubToken) await updateCommentClosed(githubToken, owner, repo, pr.number, "android");
    return;
  }

  const projectPath = core.getInput("project-path") || ".";
  if (!statSync(projectPath).isDirectory()) throw new Error("project-path must be a directory");
  const tasks = core.getInput("tasks").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const buildEnv = core.getInput("build-env", { trimWhitespace: false })
    .split(/\r?\n/).filter((line) => line.trim());
  for (const entry of buildEnv) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("Each build-env line must use KEY=VALUE syntax");
    const value = entry.slice(separator + 1);
    if (value) core.setSecret(value);
  }
  const assetName = `preview/${owner}/${repo}/pr-${pr.number}-android`;
  const previewUrl = buildPreviewUrl(
    process.env.LIMRUN_CONSOLE_URL || "https://console.limrun.com",
    assetName,
    core.getInput("open-url"),
    previewTunnel()
  );

  try {
    core.info("Creating Gradle instance...");
    const instance = await client.gradleInstances.create({
      wait: true,
      metadata: { displayName: `${repo} PR #${pr.number} preview`, labels },
    });
    const gradle = await client.gradleInstances.createClient({ instance });
    core.info(`Syncing ${projectPath}...`);
    await gradle.sync(projectPath, { watch: false });
    const prepare = core.getInput("prepare", { trimWhitespace: false });
    if (prepare.trim()) {
      core.info("Preparing the project...");
      const command = gradle.run(`set -e\n${prepare}`, {
        ...(buildEnv.length && { env: buildEnv }),
      });
      command.command.on("data", (data) => core.info(data.toString()));
      command.stdout.on("data", (data) => core.info(data.toString()));
      command.stderr.on("data", (data) => core.info(data.toString()));
      const result = await command;
      if (result.exitCode !== 0 || result.status !== "SUCCEEDED") {
        throw new Error(`Preparation ${result.status} with exit code ${result.exitCode}`);
      }
    }
    core.info(`Building and uploading asset ${assetName}...`);
    const build = gradle.gradlebuild({
      tasks: tasks.length ? tasks : ["assembleDebug"],
      ...(buildEnv.length && { env: buildEnv }),
      ...(core.getInput("gradle-project-path") && { projectPath: core.getInput("gradle-project-path") }),
      upload: { assetName },
    });
    build.command.on("data", (data) => core.info(data.toString()));
    build.stdout.on("data", (data) => core.info(data.toString()));
    build.stderr.on("data", (data) => core.info(data.toString()));
    const result = await build;
    if (result.exitCode !== 0 || result.status !== "SUCCEEDED") {
      throw new Error(`Gradle build ${result.status} with exit code ${result.exitCode}`);
    }
  } finally {
    try {
      await cleanup(client, labelSelector);
    } catch (error) {
      // Preserve the build result; the post hook retries cleanup and reports any remaining failure.
      core.warning(`Gradle cleanup failed; the post hook will retry: ${error}`);
    }
  }

  core.info(`Preview URL: ${previewUrl}`);
  core.setOutput("preview-url", previewUrl);
  core.setOutput("asset-name", assetName);
  if (githubToken) {
    await postOrUpdateComment(githubToken, owner, repo, pr.number, "android", pr.head.sha, previewUrl);
  } else {
    core.warning("github-token is unavailable; skipping the PR comment.");
  }
}
