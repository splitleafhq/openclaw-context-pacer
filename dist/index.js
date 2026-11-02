import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { wrapExternalContent } from 'openclaw/plugin-sdk/security-runtime';
import { offload, runFolder } from './offload.js';
import { Pacer, appendStatus, resolveConfig } from './pacer.js';
import { offloadTarget } from './sandbox.js';
import { isErrorResult, isRecord, resolveInner } from './tool-result.js';
const PLUGIN_ID = 'context-pacer';
/** Prompt tokens of one model call: fresh input plus cached reads and writes. */
function promptTokens(usage) {
    if (!isRecord(usage)) {
        return undefined;
    }
    const count = (key) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : 0);
    const total = count('input') + count('cacheRead') + count('cacheWrite');
    return total > 0 ? total : undefined;
}
/** True when the operator set `plugins.entries.context-pacer.hooks.allowConversationAccess`. */
export function hasConversationAccess(config) {
    const plugins = isRecord(config) && isRecord(config.plugins) ? config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const entry = isRecord(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] : {};
    return isRecord(entry.hooks) && entry.hooks.allowConversationAccess === true;
}
/** OpenClaw's untrusted-content label, naming the source when OpenClaw's wrapper has a label for it. */
export function wrap(text, toolName) {
    const source = toolName === 'web_search' || toolName === 'web_fetch' ? toolName : 'unknown';
    return wrapExternalContent(text, { source });
}
/**
 * Handlers for the hooks that report a run's context budget and prompt size. Budget and usage come from OpenClaw's
 * own resolution for the run, so no model limits are hard-coded here.
 */
export function usageHooks(pacer) {
    return {
        modelCallStarted(event, ctx) {
            const runId = event?.runId ?? ctx?.runId;
            if (runId && pacer.applies(ctx?.agentId)) {
                pacer.recordUsage(runId, event?.contextTokenBudget ?? ctx?.contextTokenBudget);
            }
        },
        // Fallback when usage arrives late or not at all: request bytes / 4 overestimates tokens (it includes the system
        // prompt and tool schemas), so the wrap-up nudge comes early rather than late.
        modelCallEnded(event, ctx) {
            const runId = event?.runId ?? ctx?.runId;
            const bytes = event?.requestPayloadBytes;
            if (runId && pacer.applies(ctx?.agentId) && typeof bytes === 'number') {
                pacer.recordUsage(runId, event?.contextTokenBudget ?? ctx?.contextTokenBudget, Math.ceil(bytes / 4), true);
            }
        },
        // `usage` is the sum over every model call of the attempt, so it overstates the prompt once a run calls the model
        // more than once. `lastAssistant`, the transcript's last assistant message, carries one call's own usage (OpenClaw
        // 2026.10.7, dist/builtin-openclaw-*.mjs: `completeEmbeddedAttemptResult` passes `getUsageTotals()` as `usage`;
        // `captureStreamSnapshot` picks `lastAssistant`).
        llmOutput(event, ctx) {
            const runId = event?.runId ?? ctx?.runId;
            if (runId && pacer.applies(ctx?.agentId)) {
                const last = event?.lastAssistant;
                pacer.recordUsage(runId, event?.contextTokenBudget ?? ctx?.contextTokenBudget, promptTokens(isRecord(last) ? last.usage : undefined));
            }
        },
        agentEnd(event, ctx) {
            const runId = event?.runId ?? ctx?.runId;
            if (runId) {
                pacer.end(runId);
            }
        },
    };
}
/**
 * Where an agent's results are saved: only where the agent can open what it is pointed to. Otherwise results pass
 * through with the status line only, and the reason is logged once per agent.
 *
 * `config` returns the gateway's config at the time of each result. OpenClaw applies changes to `agents.*` sandbox and
 * workspace settings without reloading plugins, so the snapshot from registration goes stale (2026.10.3 and 2026.10.4,
 * src/gateway/config-reload-plan.ts; docs/plugins/sdk-runtime.md, `api.config`).
 */
export function createSaveDir(config, workspaceDir, warn) {
    const warned = new Set();
    return (agentId, cwd) => {
        const c = config();
        const target = offloadTarget(c, agentId, workspaceDir(c, agentId), cwd);
        if ('dir' in target) {
            return target.dir;
        }
        const key = `${agentId}\n${target.skip}`;
        if (!warned.has(key)) {
            warned.add(key);
            warn(`offload skipped for agent "${agentId}": ${target.skip}`);
        }
        return undefined;
    };
}
/**
 * Runs after a tool executes and before the result reaches the model. Every failure returns undefined, which leaves
 * the result as it was; a thrown error or malformed output would make OpenClaw replace the result with an error
 * notice instead.
 */
export function createMiddleware(host) {
    const { pacer, warn } = host;
    return async (event, ctx) => {
        try {
            const runId = ctx.runId;
            const agentId = ctx.agentId;
            if (!runId || !agentId || !pacer.applies(agentId)) {
                return undefined;
            }
            const inner = resolveInner(event.toolName, event.args, event.result);
            const failed = event.isError === true || isErrorResult(event.result);
            const line = pacer.onToolResult(runId, inner.name, inner.args, failed);
            if (!line) {
                return undefined;
            }
            let result = event.result;
            const saveDir = pacer.config.offload.enabled && inner.result && !failed ? host.saveDir(agentId, event.cwd) : undefined;
            if (inner.result && saveDir !== undefined) {
                try {
                    const done = await offload(pacer.config.offload, host.wrap, {
                        workspaceDir: saveDir,
                        folder: pacer.folderFor(runId, () => runFolder(runId, new Date())),
                        index: pacer.gatherIndex(runId),
                        name: inner.name,
                        original: event.result,
                        inner: inner.result,
                        reserve: (bytes) => pacer.reserveBytes(runId, bytes),
                        release: (bytes) => pacer.releaseBytes(runId, bytes),
                        live: pacer.liveFolders(),
                    });
                    if (done) {
                        result = { ...event.result, content: done.content };
                    }
                }
                catch (error) {
                    warn(`kept a ${inner.name} result in context, could not save it: ${String(error)}`);
                }
            }
            return { result: appendStatus(result, line) };
        }
        catch (error) {
            warn(`left a ${event.toolName} result unchanged: ${String(error)}`);
            return undefined;
        }
    };
}
/** Registers the pacer's hooks and middleware with the host. */
export function registerPacer(api) {
    const pacer = new Pacer(resolveConfig(api.pluginConfig));
    const warn = (message) => api.logger?.warn?.(`[${PLUGIN_ID}] ${message}`);
    const hooks = usageHooks(pacer);
    api.on('model_call_started', hooks.modelCallStarted);
    api.on('model_call_ended', hooks.modelCallEnded);
    // `llm_output` and `agent_end` also carry the conversation, so OpenClaw admits them for an installed plugin only
    // when the operator sets `hooks.allowConversationAccess`. Without that grant the pacer works from the metadata hooks
    // above, and `maxTrackedRuns` bounds the counters instead of `agent_end`.
    if (hasConversationAccess(api.config)) {
        api.on('llm_output', hooks.llmOutput);
        api.on('agent_end', hooks.agentEnd);
    }
    api.registerAgentToolResultMiddleware(createMiddleware({
        pacer,
        warn,
        saveDir: createSaveDir(() => api.runtime.config.current(), (config, agentId) => api.runtime.agent.resolveAgentWorkspaceDir(config, agentId), warn),
        wrap,
    }), { runtimes: ['openclaw'] });
}
export default definePluginEntry({
    id: PLUGIN_ID,
    name: 'Context Pacer',
    description: 'Paces agents that gather with tools: a status line on each gathering result, with nudges to write notes and to finish from them, and optionally large results moved to files.',
    register: registerPacer,
});
