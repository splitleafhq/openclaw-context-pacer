/**
 * Where offload may save an agent's results so the agent can read them, or why it can't.
 *
 * A sandboxed agent sees the agent workspace only with `workspaceAccess: "rw"`. With `"none"` (the default) or `"ro"`
 * its tools run in a separate sandbox workspace, mounted read-write or read-only where the tools start, so results are
 * saved there instead (OpenClaw 2026.10.3, docs/gateway/sandboxing/workspace-access.md). OpenClaw reports that folder,
 * as a path on the gateway, in the middleware event's `cwd`: for a sandboxed run it is the workspace the tools are
 * rooted in, and OpenClaw refuses to start one anywhere else (2026.10.3 and 2026.10.4, src/agents/workspace-sandbox.ts,
 * src/agents/embedded-agent-runner/extensions.ts).
 *
 * The pointer to a saved file is relative, so the agent workspace is used only when the run's tools start there. An
 * unsandboxed run resolves `read` paths against its own working directory when it has one (an agent's `cwd` setting,
 * a spawned session's, or the CLI's), and contains `read` to it with `tools.fs.workspaceOnly` (2026.10.3 and 2026.10.4,
 * src/agents/conversation-capability-profile.ts, src/agents/core-coding-tools.ts). A sandbox a person's role requires
 * isn't visible in config; under `mode: "off"` its run reports the sandbox workspace as `cwd`, so the same check
 * skips it. `non-main` sandboxes every session but the agent's main one, so it is treated as sandboxed; an unsandboxed
 * session then reports the agent workspace as `cwd`.
 *
 * Only Docker and Podman mount a folder on the gateway into the sandbox. SSH and Crabbox seed a remote workspace once,
 * and OpenShell runs remotely or syncs around `exec`, so a file saved on the gateway can be missing from what the
 * agent's tools see (OpenClaw 2026.10.3, docs/gateway/sandboxing/ssh-backend.md, openshell-backend.md,
 * crabbox-backend.md). Backends added by plugins are unknown, so they are treated the same way.
 */
import { isAbsolute, resolve } from 'node:path';
import { isRecord } from './tool-result.js';
/** Backends whose sandbox mounts the folder OpenClaw resolved on the gateway (docs/gateway/sandboxing/docker-backend.md). */
const LOCAL_BACKENDS = new Set(['docker', 'podman']);
function sandboxSetting(config, agentId, key) {
    const agents = isRecord(config) && isRecord(config.agents) ? config.agents : {};
    const entries = isRecord(agents.entries) ? agents.entries : {};
    const entry = isRecord(entries[agentId]) ? entries[agentId] : {};
    const own = isRecord(entry.sandbox) ? entry.sandbox[key] : undefined;
    if (own !== undefined) {
        return own;
    }
    const defaults = isRecord(agents.defaults) && isRecord(agents.defaults.sandbox) ? agents.defaults.sandbox : {};
    return defaults[key];
}
/** The agent workspace, when the run's tools start there. */
function agentWorkspace(workspace, cwd) {
    return cwd === undefined || resolve(cwd) === resolve(workspace) ? { dir: workspace } : { skip: 'its tools run outside the agent workspace' };
}
/** `cwd` is the folder OpenClaw runs the agent's tools in for this run, as a path on the gateway. */
export function offloadTarget(config, agentId, workspace, cwd) {
    const mode = sandboxSetting(config, agentId, 'mode') ?? 'off';
    if (mode === 'off') {
        return agentWorkspace(workspace, cwd);
    }
    // OpenClaw's own default when no backend is set (docs/gateway/sandboxing/modes-scope-and-backend.md).
    const setting = sandboxSetting(config, agentId, 'backend');
    const backend = typeof setting === 'string' && setting.trim() ? setting.trim().toLowerCase() : 'docker';
    if (!LOCAL_BACKENDS.has(backend)) {
        return { skip: `sandbox backend "${backend}" may not see files saved on the gateway (needs docker or podman)` };
    }
    if ((sandboxSetting(config, agentId, 'workspaceAccess') ?? 'none') === 'rw') {
        // Any other folder under rw is a role-capped sandbox or a project worktree, where saved files may not be visible.
        return agentWorkspace(workspace, cwd);
    }
    return cwd !== undefined && isAbsolute(cwd) ? { dir: cwd } : { skip: "OpenClaw didn't report the sandbox workspace its tools run in" };
}
