# AGENTS.md

Rules for working in this repo.

1. Never block, cap or rewrite a tool call; only what the model sees after the tool has run may change.
2. Fail open: every error path returns `undefined` so OpenClaw keeps the original result, because a thrown error or malformed output replaces the result with an error notice.
3. Keep OpenClaw's untrusted-content warning and markers on every excerpt and saved file of external content.
4. Write only inside the workspace the agent's tools run in, under `offload.directory`, and only where the agent can read it; refuse symlinks, never overwrite a file, and delete only folders carrying the plugin's marker, or a `<directory>/.gitignore` whose bytes are exactly what earlier builds wrote, never through a symlink.
5. Hard-code no model name, context size or agent id; read limits from what OpenClaw reports for the run.
6. Follow OpenClaw's own conventions for names and locations (the workspace OpenClaw resolves, camelCase keys with unit suffixes, `enabled` for optional features); where none exists, leave the setting unset rather than invent a default.
7. Keep everything setup-agnostic: no agent names, hostnames, paths, chat ids or research topics from any real setup, in code, tests, docs, commits, issues or pull requests.
8. Build fixtures from synthetic content shaped like real OpenClaw results, never from real pages or transcripts.
9. Ship a fix with a test you have watched fail without it.
10. Before writing or changing a test, read https://github.com/splitleafhq/.github/blob/main/docs/testing.md.
11. Cite the OpenClaw version, and a docs page or source file, for any claim about OpenClaw behaviour, and label anything not yet checked on a live gateway as unverified in `docs/verification.md`.
12. Pin every tool and action to an exact version or commit.
13. Keep runtime dependencies at zero; import only `node:` built-ins and `openclaw/plugin-sdk/*`.
14. A comment states a constraint the code can't show, never what the next line does.
15. Write terse, factual prose.
16. Commit, push and open pull requests on the user's behalf; merging, tagging and releasing each need their own approval.
17. Keep agent-session links and session trailers out of commit messages, issues and pull request bodies.
