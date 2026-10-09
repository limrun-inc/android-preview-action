import * as core from "@actions/core";
import { runMain, runPost } from "./run.ts";

const entrypoint = core.getState("is-post-run") === "true" ? runPost : runMain;
entrypoint().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
