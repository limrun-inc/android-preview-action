import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { EventEmitter } from "node:events";

let inputs, state, outputs, secrets, calls, result, failure, instances;
const context = {
  eventName: "pull_request", runId: 12345, runAttempt: 2,
  repo: { owner: "example", repo: "android-app" },
  payload: {},
};
mock.module("@actions/core", { namedExports: {
  getInput: (name, options = {}) => {
    const value = inputs[name] ?? "";
    if (options.required && !value) throw new Error(`Input required: ${name}`);
    return options.trimWhitespace === false ? value : value.trim();
  },
  getState: (name) => state[name] ?? "",
  saveState: (name, value) => { state[name] = value; },
  setOutput: (name, value) => { outputs[name] = value; },
  setSecret: (value) => secrets.push(value),
  info: () => {}, warning: (value) => calls.push(["warning", value]),
}});
mock.module("@actions/github", { namedExports: { context } });
mock.module("@limrun/api/index.js", { defaultExport: class {
  gradleInstances = {
    create: async (options) => {
      calls.push(["create", options]);
      instances.push({ metadata: { id: "gradle_eu_test" } });
      if (failure === "create") throw new Error("create timeout");
      return instances[0];
    },
    createClient: async () => ({
      sync: async (...args) => {
        calls.push(["sync", ...args]);
        if (failure === "sync") throw new Error("sync failed");
      },
      run: (script, options) => {
        calls.push(["prepare", script, options]);
        const promise = failure === "prepare" ? Promise.reject(new Error("prepare failed")) : Promise.resolve(
          failure === "prepare-exit" ? { exitCode: 1, status: "FAILED" } : result
        );
        return Object.assign(promise, { command: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
      },
      gradlebuild: (options) => {
        calls.push(["build", options]);
        const promise = failure === "build" ? Promise.reject(new Error("connection lost")) : Promise.resolve(result);
        return Object.assign(promise, { command: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
      },
    }),
    list: async function* (options) {
      calls.push(["list", options]);
      yield* [...instances];
    },
    delete: async (id) => {
      calls.push(["delete", id]);
      if (failure === "delete") throw new Error("delete failed");
      instances = instances.filter((instance) => instance.metadata.id !== id);
    },
  };
}});
mock.module("../src/comment.ts", { namedExports: {
  postOrUpdateComment: async (...args) => { calls.push(["comment", ...args]); },
  updateCommentClosed: async (...args) => { calls.push(["closed", ...args]); },
}});
const { runMain, runPost, buildPreviewUrl } = await import("../src/run.ts");

beforeEach(() => {
  inputs = { "api-key": "test-api-key", "github-token": "test-github-token" };
  state = {}; outputs = {}; secrets = []; calls = []; instances = [];
  result = { exitCode: 0, status: "SUCCEEDED" }; failure = undefined;
  context.eventName = "pull_request";
  context.payload = { action: "opened", pull_request: { number: 42, head: { sha: "abc123" } } };
});

test("builds and uploads an APK, cleans up, and posts an Android preview", async () => {
  inputs["build-env"] = "API_URL=https://api.example.com?q=a=b\r\nEMPTY=\r\nTEXT= spaces + & = \r\n";
  inputs["open-url"] = "example://checkout?item=1&source=preview+test#details";
  inputs.tasks = ":app:assembleDemoDebug\n:other:assembleDebug";
  inputs["gradle-project-path"] = "android";
  await runMain();
  const build = calls.find(([kind]) => kind === "build")[1];
  assert.deepEqual(build, {
    tasks: [":app:assembleDemoDebug", ":other:assembleDebug"],
    env: ["API_URL=https://api.example.com?q=a=b", "EMPTY=", "TEXT= spaces + & = "],
    projectPath: "android",
    upload: { assetName: "preview/example/android-app/pr-42-android" },
  });
  assert.ok(secrets.includes(" spaces + & = "));
  const url = new URL(outputs["preview-url"]);
  assert.equal(url.searchParams.get("asset"), outputs["asset-name"]);
  assert.equal(url.searchParams.get("platform"), "android");
  assert.equal(url.searchParams.get("openUrl"), inputs["open-url"]);
  assert.equal(url.searchParams.has("env"), false);
  assert.equal(url.hash, "");
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "sync", "build", "list", "delete", "comment"]);
  assert.equal(calls.at(-1).at(-1), outputs["preview-url"]);
  assert.match(state["cleanup-label-selector"], /github_run_id=12345,github_run_attempt=2/);
  await runPost();
  assert.equal(calls.filter(([kind]) => kind === "delete").length, 1);
});

test("defaults to assembleDebug and publishes outputs without a GitHub token", async () => {
  inputs["github-token"] = "";
  await runMain();
  assert.deepEqual(calls.find(([kind]) => kind === "build")[1].tasks, ["assembleDebug"]);
  assert.ok(outputs["preview-url"]);
  assert.equal(calls.some(([kind]) => kind === "comment"), false);
});

for (const phase of ["create", "sync", "build"]) {
  test(`cleans up after ${phase} fails and does not post a preview`, async () => {
    failure = phase;
    await assert.rejects(runMain());
    assert.ok(calls.some(([kind]) => kind === "delete"));
    assert.deepEqual(outputs, {});
    assert.equal(calls.some(([kind]) => kind === "comment"), false);
  });
}

test("a failed Gradle result fails the action after cleanup", async () => {
  result = { exitCode: 1, status: "FAILED" };
  await assert.rejects(runMain(), /Gradle build FAILED with exit code 1/);
  assert.equal(instances.length, 0);
  assert.deepEqual(outputs, {});
});

test("post retries cleanup and reports a persistent deletion failure", async () => {
  failure = "delete";
  await runMain();
  await assert.rejects(runPost(), /Failed to clean up/);
  failure = undefined;
  await runPost();
  assert.equal(instances.length, 0);
});

test("closing a PR cleans its builders and updates the comment without building", async () => {
  context.payload.action = "closed";
  instances = [{ metadata: { id: "gradle_eu_old" } }];
  await runMain();
  assert.deepEqual(calls.map(([kind]) => kind), ["list", "delete", "closed"]);
  assert.doesNotMatch(state["cleanup-label-selector"], /github_run_id/);
  assert.match(state["cleanup-label-selector"], /github_pr=42/);
});

test("rejects malformed build env before creating a builder", async () => {
  inputs["build-env"] = "NOT_A_KEY_VALUE";
  await assert.rejects(runMain(), /KEY=VALUE/);
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});

test("does not run on pull_request_target", async () => {
  context.eventName = "pull_request_target";
  await assert.rejects(runMain(), /only works on pull_request events/);
  assert.deepEqual(calls, []);
});

test("post is a no-op when main did not save cleanup state", async () => {
  await runPost();
  assert.deepEqual(calls, []);
});

test("omits absent openUrl and preserves asset encoding", () => {
  const url = new URL(buildPreviewUrl("https://console.limrun.com", "preview/owner/app/pr-42-android", ""));
  assert.deepEqual([...url.searchParams], [["asset", "preview/owner/app/pr-42-android"], ["platform", "android"]]);
});


test("names the persistent tunnel in the preview link", async () => {
  inputs.tunnel = "staging";
  await runMain();
  assert.equal(new URL(outputs["preview-url"]).searchParams.get("tunnel"), "staging");
});

test("rejects a malformed tunnel name before creating a builder", async () => {
  inputs.tunnel = "Staging_1";
  await assert.rejects(runMain(), /tunnel must be a persistent tunnel's name/);
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});

test("prepares after sync with build-env and before the build", async () => {
  inputs.prepare = "npm ci\nnpm run generate\n";
  inputs["build-env"] = "APP_ENV=preview";
  await runMain();
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "sync", "prepare", "build", "list", "delete", "comment"]);
  assert.deepEqual(calls.find(([kind]) => kind === "prepare").slice(1), [
    "set -e\nnpm ci\nnpm run generate\n", { env: ["APP_ENV=preview"] },
  ]);
});

for (const phase of ["prepare", "prepare-exit"]) {
  test(`cleans up without building or posting when ${phase} fails`, async () => {
    inputs.prepare = "false";
    failure = phase;
    await assert.rejects(runMain());
    assert.ok(calls.some(([kind]) => kind === "delete"));
    assert.equal(calls.some(([kind]) => kind === "build" || kind === "comment"), false);
    assert.deepEqual(outputs, {});
  });
}
