# Contributing

## Setup

Node 24.16 or later. `package.json` pins the dev tools: oxlint, TypeScript, the Node types and the OpenClaw plugin SDK. CI runs these checks:

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
```

Commit `dist/` with any change to `src/`; CI fails when it doesn't match a fresh build.

Run `lefthook install` once per clone with [lefthook](https://lefthook.dev) installed. The pre-push hook then runs the same checks as CI, and a failed check stops the push.

`npm test` fails below 80% line, 85% branch or 80% function coverage of `src/`. The floor catches tests that go missing; don't add a test only to raise it.

Run the checks in a separate clone, or delete `node_modules/` from a checkout you've installed with `openclaw plugins install --link`. OpenClaw's plugin loader maps `openclaw/plugin-sdk/*` to the gateway's own install (2026.10.3), so a second copy only adds a version that can drift from the host.

## Changing the config schema

With a linked install (`openclaw plugins install --link`), the CLI validates config against the manifest on disk, while the running gateway keeps the schema it loaded. After a change to `configSchema`:
- the CLI refuses every command until the plugin's config entry matches the new schema, including the `config set` that would fix it;
- the gateway skips config reloads and refuses `plugins reload`, because the new config is invalid against the old schema.

So update the entry in the config file, check it with `openclaw config validate`, and restart the gateway. Seen on OpenClaw 2026.10.3.

## Every change starts as an issue

Open an issue before writing code, even for a one-line fix, so the reason outlives the diff. Record what the wrong behaviour was, ideally with the tool result or transcript excerpt that shows it, redacted as described below.

Branch from `main` and name the branch after the issue, as in `14-excerpt-cuts-mid-word`. Open a pull request with `Closes #14`. Merge with a squash (`gh pr merge <n> --squash --delete-branch`): the PR title becomes the commit subject and the description the commit message, so write both for `main`.

## A fix ships with a test that fails without it

Write the test first and watch it fail on the unfixed code. A test written afterwards tends to assert what the code now does rather than what it should do.

Name each test for the failure it prevents: `a symlinked save folder is refused` says what breaks; `test_ensureRealDir` doesn't.

Fixtures in `test/fixtures.ts` copy the shape of real OpenClaw tool results with synthetic content. Keep them that way: never paste a real page, search result or transcript into a fixture.

## Nothing published may identify a setup

This repository is public. The setups that run it aren't. `test/leaks.test.ts` scans every file in the repository and refuses:
- home paths;
- email addresses;
- Matrix ids;
- OpenClaw session keys;
- links to agent sessions.

It matches shapes, not names, so it can't catch everything. An agent id, a hostname or a topic from someone's research is still a leak.

**Issues and pull requests are published too, and no test can gate them.** Before posting, read the body back and remove anything about the setup it came from: agent names, rooms, paths, what was being researched. Describe the failure, not the reporter.

## OpenClaw versions

The plugin API is experimental upstream. `package.json` pins the OpenClaw version it was built and tested against (`openclaw.build`, `openclaw.compat`). Raising it means re-running the tests and the checks in [docs/verification.md](verification.md) on that version, and saying in the changelog what changed.

## Rules for the code

See [AGENTS.md](../AGENTS.md).
