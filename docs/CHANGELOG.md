# Changelog

## Unreleased

- Ships compiled `dist/`: an install runs npm without scripts, so it can't build one. `openclaw.runtimeExtensions` points at `./dist/index.js`, which OpenClaw loads from a copy, a git install or a load path. CI checks `dist/` matches a fresh build.

First version, built and tested against OpenClaw 2026.10.3.

- **Status line:** appended to each gathering result for configured agents. It counts gathering results, notices notes, reports the share of the context budget used, and nudges first to write a note, then to finish from the notes.
- **Least privilege:** reads only call metadata unless the operator grants conversation access, which adds reported token counts.
- **Tool Search:** results from `tool_call` are attributed to the tool that actually ran.
- **Note tracking (off unless `notes.pathContains` is set):** counts results since the last note and asks for one.
- **Offload (off by default):**
  - large gathering results are saved to `<workspace>/.context-pacer/<date>-<run>/` and replaced by a labelled excerpt and the file's path;
  - a truncated `web_fetch` page saved on the host is copied in, so a sandboxed agent can read it;
  - saves go through OpenClaw's root-bounded file API, which refuses symlinks and never overwrites a file;
  - for unsandboxed agents and Docker or Podman sandboxes; with `workspaceAccess` `"none"` or `"ro"`, into the sandbox workspace the agent's tools run in;
  - skipped when a run's tools start outside the folder it would save in, such as a run with its own working directory.

### Fixed

- **Config changes:** the sandbox and workspace settings that decide where results are saved were read once, when the plugin registered. OpenClaw applies changes to `agents.*` sandbox and workspace settings without reloading plugins, so a changed sandbox backend or workspace access went unseen until a restart. They're now read from the current config for each result.
- **`.gitignore`:** the plugin wrote a `.gitignore` containing `*` into `offload.directory`, so git stopped adding new files of the user's own there. Each run folder now gets its own instead. When it sets up a new run folder, the plugin deletes the one an earlier build wrote in `offload.directory`, but only if its contents are unchanged, after giving the run folders those builds created a `.gitignore` of their own; one you've edited stays.
- **Cleanup of live runs:** when a run saved its first file, cleanup kept only the newest `offload.maxRuns` folders by modification time, so a run still in progress could lose its folder to newer runs and its pointers named deleted files. Cleanup now skips the folders of runs the pacer still tracks.
- **Run folder names:** a run's folder was named from the date and the first eight letters and digits of its run id, so runs whose ids share a prefix, such as OpenClaw's `talk-realtime-consult-<uuid>`, shared one folder on the same day, and the second run's save failed when a file name collided. The name now ends with eight hex digits of the run id's SHA-256.
- **Reported usage:** the prompt size was read from `llm_output`'s `usage`, which OpenClaw sums over every model call of an attempt. After several calls it reported a multiple of the real prompt. `agent_end` usually clears the value right after, but where it doesn't follow, such as a `before_agent_finalize` revision, the run's next status lines showed the inflated share and could say to stop gathering early. It's now read from the transcript's last assistant message.
- **Run tracking:** past `maxTrackedRuns`, the run tracked longest was dropped, even one still saving, so another run's cleanup could delete its folder and its next save restarted numbering at 1. The run idle longest is dropped instead.
- **Byte limit after failed saves:** a save that failed still counted toward `offload.maxBytesPerRun`, so repeated failures could stop later saves that would succeed. A failed save now gives its bytes back.
- **Excerpt cut:** an excerpt cut without a nearby line break could end on half of a UTF-16 surrogate pair, such as an emoji. The cut now steps back one character.
- **Failed note writes:** a note write that returned an error still reset the count since the last note, so the nudge to write one stopped. A failed write no longer counts as a note.
- **Retried attempts:** with the conversation-access grant, `agent_end` resets a run's counters, but a retried attempt keeps the run id, so on the same day it saves into the same folder and its first result was named `001-<tool>.md` again. That file already existed, so the save failed and the full result stayed in context. A taken name now gets a suffix: `001-<tool>-2.md`.

### Known limits

- **Retried runs:** with the conversation-access grant, `agent_end` drops a run's state at the end of each attempt (#14), so until the retry saves again, another run's cleanup can delete the earlier attempt's folder.

- **Every agent's tool results:** while the plugin is enabled, OpenClaw checks the tool results of every agent on its `openclaw` runtime against its middleware limits and cuts what's past them, such as text over 100,000 characters, not only for the agents in `agents`. OpenClaw 2026.10.4 offers no way to scope this; see [How it works](how-it-works.md#every-agents-results).
