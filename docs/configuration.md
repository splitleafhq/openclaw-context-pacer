# Configuration

Config lives at `plugins.entries.context-pacer.config`. Anything missing or invalid falls back to its default, and numbers are clamped to the ranges below.

| Key | Default | Meaning |
|---|---|---|
| `agents` | `[]` | Agent ids to pace. Empty paces no agent, but while the plugin is enabled OpenClaw still applies its middleware limits to the tool results of every agent on its `openclaw` runtime ([Every agent's results](how-it-works.md#every-agents-results)) |
| `gatherTools` | `["web_search", "web_fetch"]` | Tools whose results count as gathering and get the status line |
| `notes.pathContains` | unset | A write counts as a note when its path contains this. Unset turns note tracking off |
| `notes.tools` | `["write", "edit"]` | Tools that can write a note |
| `notes.everyResults` | `3` | Ask for a note after this many gathering results without one (1–20) |
| `wrapUpContextFraction` | `0.6` | Share of the context budget at which the line says to stop gathering and write the answer (0.2–0.95) |
| `maxTrackedRuns` | `50` | Most runs tracked in memory at once (1–1000); the one idle longest is dropped beyond this |
| `offload.enabled` | `false` | Move large gathering results to files |
| `offload.thresholdChars` | `6000` | Offload once the text the model would see exceeds this many characters (1,000–100,000) |
| `offload.excerptChars` | `4000` | Characters shown in place of an offloaded result (500–20,000, and at most `thresholdChars` − 1,000) |
| `offload.directory` | `".context-pacer"` | Workspace-relative folder for saved results |
| `offload.maxRuns` | `10` | Run folders kept in the directory (1–100), plus the folders of runs still in progress |
| `offload.maxBytesPerRun` | `25000000` | Most bytes saved per run (1 MB–500 MB); past this, results stay in context. A save that fails gives its bytes back. With the conversation-access grant, it restarts when a run makes another attempt (see below) |

OpenClaw has no convention for an agent's working notes; its `memory/` folder is durable memory that memory search indexes and later sessions load, so it isn't a default here.

## Examples

A web research agent that keeps working notes in `notes/`:

```json
{ "agents": ["researcher"], "notes": { "pathContains": "notes/" }, "offload": { "enabled": true } }
```

An agent that explores files, without note tracking:

```json
{ "agents": ["explorer"], "gatherTools": ["read", "exec"] }
```

Set the whole object with:

```sh
openclaw config set plugins.entries.context-pacer.config '<json>' --strict-json
```

## Reported usage

By default the pacer estimates the prompt's size from each model request (bytes / 4) and marks the share "(approx)". It overestimates, so the wrap-up nudge comes early rather than late.

For exact token counts, grant the plugin conversation access:

```sh
openclaw config set plugins.entries.context-pacer.hooks.allowConversationAccess true --strict-json
openclaw plugins reload context-pacer
```

OpenClaw gates the `llm_output` hook, which reports usage, and the `agent_end` hook behind this grant because their events also carry the prompt and the model's replies. The pacer reads only the token counts from them, and without the grant it doesn't register either hook. OpenClaw sends `agent_end` at the end of an attempt, not once per run, so with the grant a run's counters, byte budget and save folder restart when the run makes another attempt, such as after a context overflow (OpenClaw 2026.10.3 and 2026.10.4, `src/agents/embedded-agent-runner/run/attempt-finalize.ts`). Without the grant, `maxTrackedRuns` bounds how many runs' counters are held.

## Where saved files go

Offloaded results are saved under `<workspace>/<offload.directory>/<YYYY-MM-DD>-<run>-<hash>/<NNN>-<tool>.md`, where `<workspace>` is the workspace the agent's tools run in. The date is the gateway's local date when the run first saves, `<run>` is the first eight letters and digits of OpenClaw's run id, and `<hash>` is the first eight hex digits of the run id's SHA-256, so runs whose ids share a prefix get separate folders. `<NNN>` counts the run's gathering results; when that name is taken, such as by an earlier attempt of the same run, the file is named `<NNN>-<tool>-2.md`, then `-3`, and so on.

- **In the workspace the agent's tools run in.**

  | Agent | Saved in |
  |---|---|
  | Unsandboxed | The agent workspace, from OpenClaw (`runtime.agent.resolveAgentWorkspaceDir`), so it follows a per-agent `workspace` setting. Skipped when the run has its own working directory |
  | Sandboxed, `workspaceAccess: "rw"` | The agent workspace, mounted read-write in the sandbox |
  | Sandboxed, `"none"` (OpenClaw's default) | The sandbox workspace under OpenClaw's sandboxes folder, mounted read-write where the tools start |
  | Sandboxed, `"ro"` | The sandbox workspace, mounted read-only where the tools start; the agent workspace is at `/agent` |

  For a sandboxed run, the plugin takes the folder from OpenClaw: the working directory it reports with each tool result. `openclaw sandbox explain --agent <id> --json` shows the same folder as `sandbox.effectiveHostWorkspaceRoot`.
- **Only where the agent can read it.** Only Docker and Podman mount a gateway folder into the sandbox; SSH and Crabbox seed a remote workspace once, and OpenShell runs remotely or syncs around `exec` (OpenClaw 2026.10.3, [SSH](https://docs.openclaw.ai/gateway/sandboxing/ssh-backend), [OpenShell](https://docs.openclaw.ai/gateway/sandboxing/openshell-backend), [Crabbox](https://docs.openclaw.ai/gateway/sandboxing/crabbox-backend)). So on any other backend, including one added by a plugin, offload passes results through with a one-time warning in the gateway log. The saved path is relative, so it does the same when an unsandboxed or `rw` run's tools start outside the agent workspace, or a `none` or `ro` run reports no working directory. An unsandboxed run starts elsewhere when it has its own working directory: an agent's `cwd` setting, a spawned session's, or the CLI's. Its `read` resolves relative paths there, and `tools.fs.workspaceOnly` keeps it there (OpenClaw 2026.10.3, `src/agents/conversation-capability-profile.ts`, `src/agents/core-coding-tools.ts`). The check reads `agents.entries.<id>.sandbox`, then `agents.defaults.sandbox`, from the gateway's current config, so with the default hybrid reload a change applies without a restart (see [Config changes](how-it-works.md#config-changes)). A sandbox required by a person's role isn't visible in config; under `mode: "off"` its run reports the sandbox workspace as its working directory, so it is skipped the same way.
- **Kept out of git backups.** OpenClaw recommends backing up the workspace with git. Each run folder gets a `.gitignore` that ignores everything in it, as OpenClaw does for each folder of staged inputs it creates (2026.10.3 and 2026.10.4, `src/media/staged-inputs.ts`). Nothing else in `offload.directory` is ignored, so new files of your own there are added to your backups. The `.gitignore` earlier builds wrote in `offload.directory` is deleted when a new run folder is set up, only if its contents are unchanged and it isn't a symlink. Run folders those builds created get their own `.gitignore` first; if one can't be written, the old file stays. Only the current `offload.directory` is checked: if you changed it, delete the old file from the previous folder yourself.
- **Files are private:** mode 0600, in folders with mode 0700.
- **Path rules:** `offload.directory` must be a plain relative path; a leading dot is fine, `.` and `..` are not. Anything else falls back to the default.
- **No symlinks, no overwrites:** unless the workspace is read-only to it, the agent can write there too, so every save goes through OpenClaw's root-bounded file API (`root` from `openclaw/plugin-sdk/security-runtime`). It refuses a symlink anywhere below the workspace, including a dangling one and one swapped in during a save, and never replaces an existing file. How strictly a swap is caught depends on the platform and fs-safe's native helper (`@openclaw/fs-safe` 0.24.2, bundled with OpenClaw 2026.10.3, `docs/security-model.md`).
- **Cleanup:** each run folder holds a `.context-pacer-run` marker. When a run saves its first file, marked folders beyond the newest `offload.maxRuns` are deleted, except those of runs the pacer still tracks. A run is tracked until `maxTrackedRuns` other runs have been active since its last result, so at most `offload.maxRuns` + `maxTrackedRuns` folders are kept. With the conversation-access grant, `agent_end` also stops tracking a run at the end of each attempt, so a retried run's folder is unprotected until the retry saves again (#14). Folders without the marker are never touched.
- **Shared sandbox workspaces:** under `none` or `ro`, the sandbox workspace follows the sandbox scope. With `scope: "shared"`, every sandboxed agent saves into the same one, so their run folders share one `offload.maxRuns` budget, and cleanup can delete another agent's older, finished folders (OpenClaw 2026.10.3, `src/agents/sandbox/shared.ts`).

## How the defaults were chosen

`offload.thresholdChars` and `offload.excerptChars` were sized on one research agent's stored results on OpenClaw 2026.10.3:
- A five-result `web_search` in readable form was 3,685 characters at the median and 4,661 at the 90th percentile, so a 4,000-character excerpt shows a typical search whole.
- A fetched page was about 6,300 characters at the median.

Agents with other tools may want different values.
