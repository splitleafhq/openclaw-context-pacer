# openclaw-context-pacer

An [OpenClaw](https://docs.openclaw.ai) plugin (id `context-pacer`) for agents that gather with tools: web research, browsing, file exploration. It helps them keep notes and finish from those notes, instead of gathering until their context overflows.

It never blocks a tool. It changes only what the model sees after a tool has run.

**Status:** experimental. Built and tested against OpenClaw 2026.10.3. Not published on ClawHub or npm; install it from source. What has and hasn't been checked on a live gateway is listed in [docs/verification.md](docs/verification.md).

## What it does

**A status line on every gathering result.** By default the gathering tools are `web_search` and `web_fetch`, and the line is added before the result reaches the model:

```text
[pacer] 7 gathering results so far · last note 3 results ago · context about 48% of budget. Add what these sources showed to your notes before gathering more.
```

The line escalates in two steps:
1. With note tracking on (`notes.pathContains` set), after `notes.everyResults` results with no note, it asks for one. Without it, the line leaves notes out.
2. Once the prompt reaches `wrapUpContextFraction` of the run's context budget, it says to stop gathering and write the answer.

**Offload (optional, off by default).** A large result is saved to a file in the workspace the agent's tools run in. The model gets an excerpt and the file's path in its place:

```text
[pacer] Showing the first 3,962 of 6,337 characters. The full result is saved at .context-pacer/2026-10-15-3f9c1a2b-9d41e07c/004-web_fetch.md: read it with offset and limit if you need more.
```

Nothing is dropped: the agent can `read` the rest when it needs it. Offload applies to unsandboxed agents and to Docker or Podman sandboxes. With `workspaceAccess` `"none"` (OpenClaw's default) or `"ro"`, files go in the sandbox workspace rather than the agent workspace. In a replay of 247 stored results from one research agent, offload cut the text the model saw by about 65%. That measures size only, not answer quality.

## Install

Pinned to a tag or commit:

```sh
openclaw plugins install git:github.com/splitleafhq/openclaw-context-pacer@<tag or commit> --force --accept-capabilities
openclaw plugins enable context-pacer
openclaw config set plugins.entries.context-pacer.config '{"agents":["<agent id>"],"offload":{"enabled":true}}' --strict-json
openclaw gateway restart
```

- OpenClaw loads the committed `dist/` through `openclaw.runtimeExtensions`, from a git install, a copy, a load path or `--link` alike (`docs/plugins/sdk-entrypoints/package-entries.md:36-38`, 2026.10.8), checked on 2026.10.8: an install runs npm without scripts, so nothing is built then, and a change to `src/` runs only after `npm run build`.
- `--force` confirms a source that isn't on ClawHub.
- Installed plugins can rewrite tool results only when they're explicitly enabled, which is what `plugins enable` does.
- It paces no agent until `agents` lists at least one agent id. While it's enabled, every tool result of every agent on OpenClaw's `openclaw` runtime passes through OpenClaw's middleware runner, even with `agents` empty. OpenClaw 2026.10.8 and earlier also cut results past its middleware limits there; 2026.10.10 and later don't (see [How it works](docs/how-it-works.md#every-agents-results)). To take the plugin out of that path, disable it.

To check that it loaded, run `openclaw plugins inspect context-pacer --runtime --json`.

To turn it off, run `openclaw plugins disable context-pacer` and restart. Saved files stay in the `.context-pacer/` folder of each workspace they were saved in until you delete them.

## Bounds

- **Scoped:** the pacer changes only results from agents in `agents`, and only from `gatherTools`. On OpenClaw 2026.10.8 and earlier, registering it also made OpenClaw cut any agent's tool result past its middleware limits, such as text over 100,000 characters; 2026.10.10 and later don't (see [How it works](docs/how-it-works.md#every-agents-results)).
- **Never blocks:** it doesn't veto, cap or rewrite tool calls.
- **Fails open:** any error leaves the result as it was and logs a warning. If a save fails, the full result stays in context.
- **Agnostic:** context share comes from the budget OpenClaw resolves for the run, so no model name or window size is hard-coded.
- **No conversation access by default:** it reads only call metadata, and estimates prompt size from the request's size. Grant `hooks.allowConversationAccess` to use the reported token counts instead (see [Configuration](docs/configuration.md#reported-usage)).
- **Keeps the untrusted-content label:** excerpts and saved files of web content carry OpenClaw's warning and markers.
- **Doesn't hide loops:** OpenClaw's loop detection records each outcome before this plugin runs.

## Docs

- [Configuration](docs/configuration.md): every key, with examples for agents other than web research.
- [How it works](docs/how-it-works.md): the hooks it uses, Tool Search, offload, and measurements.
- [Verification](docs/verification.md): what's tested, what isn't, and how to check it on your gateway.

## Develop

Requires Node 24.16 or later.

```sh
npm ci --ignore-scripts
npm run lint && npm run typecheck && npm test
npm run build
```

Commit `dist/` with any change to `src/`; CI fails when it doesn't match a fresh build.

See [CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

[MIT](LICENSE)
