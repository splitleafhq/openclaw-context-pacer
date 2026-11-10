# Verification

## Checked

- **Unit tests** (`npm test`) cover:
  - the status line and its escalation;
  - config fallbacks and clamping;
  - unwrapping Tool Search's call control, under both `tool_call` and `dispatch_action`;
  - offload: excerpts, saved files, the "Full page" copy, the path rules, cleanup and `.gitignore`;
  - symlinks: a symlinked save folder, a dangling symlink at the run marker, and a run folder swapped for a symlink between a path check and the write;
  - where saves go for each sandbox mode, workspace access and backend, given the working directory a run reports;
  - the leak scan;
  - OpenClaw's own middleware runner, from the SDK, passing an unpaced agent's oversized result unchanged once it is given the pacer's middleware (the test calls the runner directly, not OpenClaw's plugin loader).
- **Typecheck** against the OpenClaw 2026.10.3 plugin SDK, in CI.
- **Replay** of 247 stored `web_search` and `web_fetch` results from one research agent on 2026.10.3 through offload with the default settings: 0 errors. What the model saw fell from 2.88 million characters to 1.02 million. That's size only, not answer quality.
- **Installs in OpenClaw 2026.10.8:** in an isolated state directory (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`), `plugins install git:file://<checkout>@<commit> --force --accept-capabilities`, and the same from a checkout path, then `plugins inspect context-pacer --runtime --json` reports `status: loaded` from `dist/index.js` with the `model_call_started` and `model_call_ended` hooks. Before `dist/` was committed, the git install failed: "requires compiled runtime output for TypeScript entry ./src/index.ts".

## Checked on a live gateway (OpenClaw 2026.10.3)

- A linked install loads, and the gateway applies it without a restart (`openclaw plugins install --link`, then `plugins enable` and `config set`). `plugins inspect --runtime` reports it as loaded, with no diagnostics.
- Without `hooks.allowConversationAccess`, OpenClaw blocks `llm_output` and `agent_end` for a non-bundled plugin and logs a warning for each. The plugin now registers them only when the grant is set.
- A research run with offload on:
  - status lines reached the model, with a context share estimated from request size;
  - large results were saved, with the `.gitignore` in place (at the time, one for the whole save folder; now one per run folder);
  - the agent opened a saved file with `read` from a Podman sandbox with `workspaceAccess: "rw"`, despite the files' 0600 mode;
  - no result was replaced by a post-processing error.
- `model_call_ended.requestPayloadBytes` is populated for embedded runs. The estimate it gives was close to the reported prompt size early in a run.

## Checked on a live gateway (OpenClaw 2026.10.4)

On 2026-10-18, with the plugin at commit 13a7696 and the agent sandboxed with `workspaceAccess: "none"`:
- Three research runs. Offload saved 12, 16 and 7 tool results into the sandbox workspace's `.context-pacer/` folder: three run folders holding 35 saved results. Each folder also gets a marker, and the build at that commit wrote one `.gitignore` for the whole save folder, so 39 files by design.
- The agent read them back 7, 12 and 4 times.
- The gateway log had no "offload skipped" line.
- Peak prompts were 82.9K, 88.1K and 34.7K tokens.
- The counts' source: a local harness read OpenClaw's session events for the three runs. Saved results are those carrying the pacer's saved-at line, read-backs are `read` calls into the run folder, and the peak is the largest prompt token count of any model call. The gateway log was checked only for "offload skipped" lines.

So under `none`, the plugin saved under `event.cwd` into the workspace the agent's tools run in, and the agent called `read` on those files. The counts don't record whether each `read` succeeded.

## Checked on a live gateway (OpenClaw 2026.10.5)

On 2026-10-20, with the plugin at commit b40a9ae and the agent sandboxed with `workspaceAccess: "none"`, the same three research questions as the 2026-10-18 check:
- Offload saved 19, 27 and 6 tool results. Each run folder holds its saved results, its marker and its own `.gitignore`; the save folder itself has none.
- The save folder's `.gitignore` from the earlier build was removed once the existing run folders had their own (10 of 10).
- The agent read saved files back 19, 0 and 2 times. All 21 reads succeeded.
- The gateway log had no "offload skipped" line.
- Peak prompts were 101.8K, 74.4K and 45.3K tokens.
- Counted as on 2026-10-18, plus a read counts as failed when its tool result is an error.

Not seen in this check: a change to `agents.*` settings reaching the plugin mid-run, since none changed during the runs.

## Not yet checked on a live gateway

- Offload for unsandboxed agents. The plugin allows it there, but only sandboxed agents have been run live: `rw` on 2026.10.3, `none` on 2026.10.4.
- Offload under `workspaceAccess: "ro"`. Read from OpenClaw's source and covered by unit tests only:
  - that `event.cwd` is the sandbox workspace on a live gateway;
  - that the agent's `read` opens a saved file from the read-only mount.
- The skips for backends other than Docker and Podman, for an unsandboxed or `rw` run whose tools start outside the agent workspace, and for a sandbox a person's role requires under `mode: "off"`. Unit tests only.
- Saved files are mode 0600 and owned by the gateway's user. A sandbox whose container user is a different host user may not be able to read them. A Podman `rw` sandbox (2026.10.3) and a `none` sandbox (2026.10.5) have been seen reading them; other container users are unchecked.
- That a change to `agents.*` sandbox or workspace settings reaches the plugin through `api.runtime.config.current()` without a restart, and that a change to the plugin's entry replaces its instance. Read from OpenClaw's docs and source (2026.10.3 and 2026.10.4, `docs/plugins/sdk-runtime.md`, `src/gateway/config-reload-plan.ts`). The unit tests cover only that the pacer reads `current()` for each result.
- That OpenClaw applies no size limit to results passing through its middleware runner. Read from the published packages (2026.10.10 and 2026.11.1, `dist/tool-result-middleware-*.mjs`, which they build from `src/agents/harness/tool-result-middleware.ts`), compared with 2026.10.8, which validated and cut; the unit test runs the 2026.10.10 SDK's runner; not seen on a live gateway.
- What OpenClaw does on each run when a plugin declares tool-result middleware but registers none. Its loader falls back to loading the plugin (2026.10.3 and 2026.10.4, `src/plugins/agent-tool-result-middleware-loader.ts`); whether that load is cached, and what it costs, isn't checked.
- Managed project worktrees. A session with one runs its tools in a private checkout, so the plugin saves there. Whether OpenClaw keeps, reconciles or publishes those files isn't checked.
- Whether `llm_output` fires per model call or once per run, with the conversation-access grant. The request-size estimate covers the gap.
- Whether `model_call_started` carries `runId` and the agent id for embedded runs.
- Whether reading saved files back improves answers. In the three 2026.10.4 runs above, the agent did read them.
- That `agent_end` fires at the end of an attempt, so a retried run's counters, byte budget and save folder restart. Read from source (2026.10.3 and 2026.10.4, `src/agents/embedded-agent-runner/run/attempt-finalize.ts`); not seen on a live gateway.
- That a retried attempt keeps the run id. Read from the built package (2026.10.7, `dist/embedded-agent-*.mjs`: the attempt loop reuses `params.runId`); not seen on a live gateway. **Naming a retried attempt's files apart from the earlier attempt's** (#64) is unit-tested only.
- **Its own log lines** (the `pacing run` and outcome lines and the unknown-call-control warning): unit-tested through the SDK's middleware runner; not yet seen in a live gateway log. Expected at the default log level: in 2026.11.2 every plugin, bundled or installed, gets the same `plugins` subsystem logger (`dist/registry-*.mjs`, `dist/loader-runtime-load-*.mjs`, `createPluginRuntimeLoaderLogger`), the file log defaults to `info` (docs/gateway/logging.md), and a bundled plugin's info lines (active-memory's) appear in a gateway log with `logging` unset.
- **Keeping the folders of runs in progress when cleaning up** (#45) and **reading `llm_output`'s prompt size from the last call, not the attempt total** (#46) and **keeping runs whose ids share a prefix in separate save folders** (#65): unit-tested, not yet run on a live gateway.

## Checking it on your gateway

1. Run `openclaw plugins inspect context-pacer --runtime --json`. The plugin should be loaded, with no diagnostics.
2. Search the gateway log for `context-pacer`. A warning there means a result was left unchanged.
3. Ask a paced agent a question that needs several searches and fetches, then read its transcript:
   - each gathering result ends with a `[pacer]` line;
   - with offload on, large results show an excerpt and a path, and a file exists at that path in the workspace the agent's tools run in. For a `none` or `ro` sandbox, that's the folder `openclaw sandbox explain --agent <id> --json` reports as `sandbox.effectiveHostWorkspaceRoot`;
   - nothing says "Tool output unavailable due to post-processing error".
4. If the agent ran a `read` on a saved file, check that the read succeeded inside its sandbox.
