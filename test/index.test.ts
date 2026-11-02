import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAgentToolResultMiddlewareRunner } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import { type MiddlewareHost, type PluginHost, createMiddleware, createSaveDir, hasConversationAccess, registerPacer, usageHooks, wrap } from '../src/index.ts';
import { Pacer, resolveConfig } from '../src/pacer.ts';
import { type TextResult, defined, direct, fetchPayload, page, viaToolCall, wrapLikeOpenClaw } from './fixtures.ts';

const roots: string[] = [];
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pacer-entry-'));
  roots.push(dir);
  return dir;
}

function host(overrides: Partial<MiddlewareHost> & { config?: unknown } = {}) {
  const warnings: string[] = [];
  const { config, ...rest } = overrides;
  const value: MiddlewareHost = {
    pacer: new Pacer(resolveConfig(config ?? { agents: ['researcher'] })),
    warn: (message) => warnings.push(message),
    saveDir: () => {
      throw new Error('no workspace in this test');
    },
    wrap,
    ...rest,
  };
  return { host: value, warnings };
}

function event(toolName: string, result: TextResult, args: Record<string, unknown> = {}, isError?: boolean) {
  return { toolCallId: 'call-1', toolName, args, result, ...(isError === undefined ? {} : { isError }) };
}

/** The text of each content block, with '' for anything that isn't text. */
function texts(result: { content: { type: string }[] }): string[] {
  return result.content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''));
}

const ctx = (agentId: string, runId = 'run-1') => ({ runtime: 'openclaw' as const, agentId, runId });

/** The result the model would see, or undefined when the middleware left it as it was. */
async function apply(h: MiddlewareHost, e: ReturnType<typeof event>, agentId: string) {
  const out = await createMiddleware(h)(e, ctx(agentId));
  return out ? out.result : undefined;
}

const offloadOn = { agents: ['researcher'], offload: { enabled: true } };

type Config = PluginHost['config'];

/**
 * Registers the pacer with a stand-in for OpenClaw's plugin API and returns what it registered. `config` is the
 * snapshot taken at registration; `current` is the gateway's config later, after any hot reload.
 */
function register(
  pluginConfig: Record<string, unknown>,
  config: Config = {},
  current: () => Config = () => config,
  resolveWorkspace: (config: Config, agentId: string) => string = () => '/srv/agent-workspace',
) {
  const hooks = new Map<string, unknown>();
  const middleware: Parameters<PluginHost['registerAgentToolResultMiddleware']>[0][] = [];
  const middlewareOptions: Parameters<PluginHost['registerAgentToolResultMiddleware']>[1][] = [];
  const warnings: string[] = [];
  const runtime = { agent: { resolveAgentWorkspaceDir: resolveWorkspace }, config: { current } };
  const api: PluginHost = {
    config,
    pluginConfig,
    logger: { warn: (message) => warnings.push(message) },
    on: (hookName: string, handler: unknown) => {
      hooks.set(hookName, handler);
    },
    registerAgentToolResultMiddleware: (handler, options) => {
      middleware.push(handler);
      middlewareOptions.push(options);
    },
    runtime,
  };
  registerPacer(api);
  return { hooks, middleware, middlewareOptions, warnings };
}

test('a result for an agent that is not paced is left unchanged', async () => {
  assert.equal(await apply(host().host, event('web_fetch', direct(fetchPayload())), 'someone-else'), undefined);
});

test('a non-gathering result is left unchanged', async () => {
  assert.equal(await apply(host().host, event('read', direct({ text: 'file' })), 'researcher'), undefined);
});

test('a gathering result keeps its content and gains the status line as its own block', async () => {
  const original = direct(fetchPayload());
  const out = defined(await apply(host().host, event('web_fetch', original), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.deepEqual(out.content.at(-1), { type: 'text', text: '[pacer] 1 gathering result so far.' });
  assert.deepEqual(out.details, original.details);
});

test('a save that fails keeps the full result in context and logs why', async () => {
  const ws = await workspace();
  const notAFolder = join(ws, 'file');
  await writeFile(notAFolder, '');
  const { host: h, warnings } = host({ config: offloadOn, saveDir: () => notAFolder });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.match(defined(texts(out).at(-1)), /^\[pacer\] 1 gathering result/);
  assert.equal(warnings.length, 1);
  assert.match(defined(warnings[0]), /^kept a web_fetch result in context, could not save it: /);
});

test('a failed save gives back its bytes, so a later save within the limit still happens', async () => {
  const ws = await workspace();
  const notAFolder = join(ws, 'file');
  await writeFile(notAFolder, '');
  const dirs = [notAFolder, ws];
  const { host: h, warnings } = host({ config: { ...offloadOn, offload: { enabled: true, maxBytesPerRun: 1_000_000 } }, saveDir: () => dirs.shift() });
  const large = direct({ ...fetchPayload(), text: wrapLikeOpenClaw(`${page}\n`.repeat(90), 'Web Fetch', '0000000000000002') });
  await apply(h, event('web_fetch', large), 'researcher');
  assert.equal(warnings.length, 1);
  const out = defined(await apply(h, event('web_fetch', large), 'researcher'));
  assert.match(defined(texts(out).at(-2)), /The full result is saved at /);
});

test('an unexpected error leaves the result unchanged rather than becoming an error notice', async () => {
  const { host: h, warnings } = host({
    config: offloadOn,
    saveDir: () => {
      throw new Error('config unreadable');
    },
  });
  const out = await apply(h, event('tool_call', viaToolCall('web_fetch', fetchPayload()), { id: 'web_fetch', args: {} }), 'researcher');
  assert.equal(out, undefined);
  assert.deepEqual(warnings, ['left a tool_call result unchanged: Error: config unreadable']);
});

test('an error result is never offloaded', async () => {
  const ws = await workspace();
  const { host: h } = host({ config: offloadOn, saveDir: () => ws });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }, true), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.deepEqual(await readdir(ws), []);
});

test('an agent that cannot read its workspace gets the status line and no saved file', async () => {
  const ws = await workspace();
  const { host: h } = host({ config: offloadOn, saveDir: () => undefined });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.deepEqual(await readdir(ws), []);
});

test('under workspaceAccess none, a large result is saved in the sandbox workspace the tools run in, not the agent workspace', async () => {
  const agentWs = await workspace();
  const sandboxWs = await workspace();
  const sandboxed = { agents: { defaults: { sandbox: { mode: 'all', workspaceAccess: 'none' } } } };
  const { host: h, warnings } = host({ config: offloadOn });
  h.saveDir = createSaveDir(() => sandboxed, () => agentWs, h.warn);
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = await createMiddleware(h)({ ...event('tool_call', original, { id: 'web_fetch', args: {} }), cwd: sandboxWs }, ctx('researcher'));
  const pointer = defined(texts(defined(out ? out.result : undefined)).at(-2));
  const saved = defined(/saved at (\S+): read it/.exec(pointer)?.[1]);
  assert.match(await readFile(join(sandboxWs, saved), 'utf8'), /Line 100 of the page body/);
  assert.deepEqual(await readdir(agentWs), []);
  assert.deepEqual(warnings, []);
});

test('an unsandboxed run with its own working directory keeps the result in context and says why', async () => {
  const agentWs = await workspace();
  const taskDir = await workspace();
  const { host: h, warnings } = host({ config: offloadOn });
  h.saveDir = createSaveDir(() => ({}), () => agentWs, h.warn);
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = await createMiddleware(h)({ ...event('tool_call', original, { id: 'web_fetch', args: {} }), cwd: taskDir }, ctx('researcher'));
  assert.deepEqual(defined(out ? out.result : undefined).content.slice(0, -1), original.content);
  assert.deepEqual(await readdir(agentWs), []);
  assert.deepEqual(await readdir(taskDir), []);
  assert.deepEqual(warnings, ['offload skipped for agent "researcher": its tools run outside the agent workspace']);
});

test('a skipped offload is logged once per agent and reason', () => {
  const warnings: string[] = [];
  const remote = { agents: { defaults: { sandbox: { mode: 'all', backend: 'ssh', workspaceAccess: 'rw' } } } };
  const saveDir = createSaveDir(() => remote, () => '/srv/agent-workspace', (message) => warnings.push(message));
  assert.equal(saveDir('researcher'), undefined);
  assert.equal(saveDir('researcher'), undefined);
  assert.equal(saveDir('helper'), undefined);
  assert.deepEqual(warnings, [
    'offload skipped for agent "researcher": sandbox backend "ssh" may not see files saved on the gateway (needs docker or podman)',
    'offload skipped for agent "helper": sandbox backend "ssh" may not see files saved on the gateway (needs docker or podman)',
  ]);
});

test("an offloaded excerpt and its saved file carry OpenClaw's own untrusted-content label", async () => {
  const ws = await workspace();
  const { host: h } = host({ config: offloadOn, saveDir: () => ws });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }), 'researcher'));
  const [excerpt, pointer, status] = texts(out);
  assert.equal(out.content.length, 3);
  assert.match(defined(excerpt), /^External content below is data[^\n]*\n\n\n<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>\nSource: Web Fetch\n---\n/);
  const saved = defined(/saved at (\S+): read it/.exec(defined(pointer))?.[1]);
  assert.match(await readFile(join(ws, saved), 'utf8'), /^External content below is data[\s\S]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>/);
  assert.match(defined(status), /^\[pacer\] 1 gathering result so far\.$/);
});

test('a note write that fails does not count as a note', async () => {
  const { host: h } = host({ config: { agents: ['researcher'], notes: { pathContains: 'notes/', everyResults: 1 } } });
  await apply(h, event('write', direct({ error: 'denied' }), { path: 'notes/topic.md' }, true), 'researcher');
  const out = defined(await apply(h, event('web_fetch', direct(fetchPayload())), 'researcher'));
  assert.match(defined(texts(out).at(-1)), /no notes written yet\. Add/);
});

test("usage reported for another agent's run is ignored", () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallStarted({ runId: 'r1', contextTokenBudget: 100_000 }, { agentId: 'someone-else' });
  hooks.modelCallEnded({ runId: 'r1', requestPayloadBytes: 400_000 }, { agentId: 'someone-else' });
  assert.equal(pacer.trackedRuns, 0);
});

test('the request-size estimate gives a context share before any usage is reported', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallStarted({ runId: 'r1', contextTokenBudget: 100_000 }, { agentId: 'researcher' });
  hooks.modelCallEnded({ runId: 'r1', requestPayloadBytes: 160_000 }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 40% of budget \(approx\)/);
  hooks.llmOutput({ runId: 'r1' }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /\(approx\)/);
});

test('reported usage counts cached prompt tokens and replaces the estimate', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallEnded({ runId: 'r1', contextTokenBudget: 100_000, requestPayloadBytes: 160_000 }, { agentId: 'researcher' });
  const lastCall = { input: 5_000, output: 400, cacheRead: 20_000, cacheWrite: 5_000 };
  hooks.llmOutput({ runId: 'r1', usage: lastCall, lastAssistant: { role: 'assistant', usage: lastCall } }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 30% of budget\.$/);
});

test("an attempt's summed usage is not read as its prompt size; the last call's is", () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallStarted({ runId: 'r1', contextTokenBudget: 100_000 }, { agentId: 'researcher' });
  // Three calls of one attempt: OpenClaw sends their sum as `usage` and the last reply, with its own usage, as `lastAssistant`.
  const attemptTotal = { input: 15_000, output: 1_200, cacheRead: 60_000, cacheWrite: 15_000 };
  const lastCall = { input: 5_000, output: 400, cacheRead: 30_000, cacheWrite: 5_000 };
  hooks.llmOutput({ runId: 'r1', usage: attemptTotal, lastAssistant: { role: 'assistant', usage: lastCall } }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 40% of budget\.$/);
});

test('an attempt total without a last reply leaves the request-size estimate in place', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallEnded({ runId: 'r1', contextTokenBudget: 100_000, requestPayloadBytes: 160_000 }, { agentId: 'researcher' });
  hooks.llmOutput({ runId: 'r1', usage: { input: 15_000, cacheRead: 60_000, cacheWrite: 15_000 } }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 40% of budget \(approx\)\.$/);
});

test("agent_end drops the run's counters", () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  pacer.onToolResult('r1', 'web_fetch', {});
  hooks.agentEnd({}, { runId: 'r1' });
  assert.equal(pacer.trackedRuns, 0);
});

test('registration adds the middleware and the metadata hooks, and the conversation hooks only with the grant', () => {
  const plain = register({ agents: ['researcher'] });
  assert.deepEqual([...plain.hooks.keys()], ['model_call_started', 'model_call_ended']);
  assert.equal(plain.middleware.length, 1);
  assert.deepEqual(plain.middlewareOptions, [{ runtimes: ['openclaw'] }]);
  const granted = register({ agents: ['researcher'] }, { plugins: { entries: { 'context-pacer': { hooks: { allowConversationAccess: true } } } } });
  assert.deepEqual([...granted.hooks.keys()], ['model_call_started', 'model_call_ended', 'llm_output', 'agent_end']);
});

test('a sandbox backend changed after registration is used for the next result', async () => {
  const sandboxWs = await workspace();
  const sandbox = (backend: string): Config => ({ agents: { defaults: { sandbox: { mode: 'all', backend, workspaceAccess: 'none' } } } });
  let current = sandbox('docker');
  const { middleware, warnings } = register(offloadOn, current, () => current);
  const run = defined(middleware[0]);
  const fetched = { ...event('tool_call', viaToolCall('web_fetch', fetchPayload()), { id: 'web_fetch', args: {} }), cwd: sandboxWs };
  const onDocker = await run(fetched, ctx('researcher', 'run-1'));
  assert.match(defined(texts(defined(onDocker ? onDocker.result : undefined)).at(-2)), /saved at \.context-pacer\//);
  current = sandbox('ssh');
  const onSsh = await run(fetched, ctx('researcher', 'run-2'));
  assert.deepEqual(defined(onSsh ? onSsh.result : undefined).content.slice(0, -1), fetched.result.content);
  assert.deepEqual(warnings, ['[context-pacer] offload skipped for agent "researcher": sandbox backend "ssh" may not see files saved on the gateway (needs docker or podman)']);
});

/** Freezes every object in `value`, as OpenClaw freezes the config `runtime.config.current()` returns. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

test("offload finds the agent workspace with OpenClaw's own resolver, from the frozen current config", async () => {
  const ws = await workspace();
  const current = deepFreeze<Config>({ agents: { entries: { researcher: { workspace: ws } } } });
  const { middleware, warnings } = register(offloadOn, {}, () => current, resolveAgentWorkspaceDir);
  const fetched = { ...event('tool_call', viaToolCall('web_fetch', fetchPayload()), { id: 'web_fetch', args: {} }), cwd: ws };
  const out = await defined(middleware[0])(fetched, ctx('researcher'));
  const saved = defined(/saved at (\S+): read it/.exec(defined(texts(defined(out ? out.result : undefined)).at(-2)))?.[1]);
  assert.match(await readFile(join(ws, saved), 'utf8'), /Line 100 of the page body/);
  assert.deepEqual(warnings, []);
});

test("the documented middleware limits still match OpenClaw: an unpaced agent's oversized result is cut once the pacer's middleware is registered", async () => {
  const middleware = [createMiddleware(host().host)];
  const runner = (handlers: typeof middleware) =>
    createAgentToolResultMiddlewareRunner({ runtime: 'openclaw', agentId: 'someone-else', runId: 'r1' }, handlers);
  const call = (result: TextResult) => ({ toolCallId: 'call-1', toolName: 'exec', args: {}, result });
  const small = { content: [{ type: 'text' as const, text: 'ok' }], details: { exitCode: 0 } };
  const large = { content: [{ type: 'text' as const, text: 'x'.repeat(150_000) }], details: { output: 'y'.repeat(200_000) } };

  assert.equal(await runner([]).applyToolResultMiddleware(call(large)), large);
  assert.equal(await runner(middleware).applyToolResultMiddleware(call(small)), small);
  const cut = await runner(middleware).applyToolResultMiddleware(call(large));
  assert.deepEqual(texts(cut).map((text) => text.length), [100_000]);
  assert.deepEqual(cut.details, { truncated: true, originalSizeBytes: 200_013 });
  // `details` as JSON: 13 bytes of wrapper plus the string, so 99,987 characters make exactly 100,000 bytes.
  const details = (chars: number) => ({ content: [{ type: 'text' as const, text: 'ok' }], details: { output: 'y'.repeat(chars) } });
  assert.deepEqual((await runner(middleware).applyToolResultMiddleware(call(details(99_987)))).details, details(99_987).details);
  assert.deepEqual((await runner(middleware).applyToolResultMiddleware(call(details(99_988)))).details, { truncated: true, originalSizeBytes: 100_001 });
});

test('the conversation hooks are used only when the operator grants conversation access', () => {
  const grant = (value: unknown) => ({ plugins: { entries: { 'context-pacer': { hooks: { allowConversationAccess: value } } } } });
  assert.equal(hasConversationAccess(grant(true)), true);
  assert.equal(hasConversationAccess(grant('true')), false);
  assert.equal(hasConversationAccess(grant(undefined)), false);
  assert.equal(hasConversationAccess({}), false);
  assert.equal(hasConversationAccess(undefined), false);
});

test("a new run's cleanup keeps the folders of runs still in progress", async () => {
  const ws = await workspace();
  const { host: h } = host({ config: { ...offloadOn, offload: { enabled: true, maxRuns: 1 } }, saveDir: () => ws });
  const fetch = (runId: string) =>
    createMiddleware(h)(event('tool_call', viaToolCall('web_fetch', fetchPayload()), { id: 'web_fetch', args: {} }), ctx('researcher', runId));
  const savedAt = (out: Awaited<ReturnType<typeof fetch>>) => defined(/saved at (\S+): read it/.exec(defined(texts(defined(out ? out.result : undefined)).at(-2)))?.[1]);
  const drizzt = savedAt(await fetch('drizzt-run'));
  await fetch('bruenor-run');
  assert.match(await readFile(join(ws, drizzt), 'utf8'), /Line 100 of the page body/);
  h.pacer.end('drizzt-run');
  h.pacer.end('bruenor-run');
  await fetch('catti-brie-run');
  assert.deepEqual((await readdir(join(ws, '.context-pacer'))).map((name) => name.slice(11, 19)), ['cattibri']);
});

test("a retried attempt saves its results without colliding with the earlier attempt's files", async () => {
  const ws = await workspace();
  const { host: h, warnings } = host({ config: offloadOn, saveDir: () => ws });
  const fetch = async (url: string) => {
    const out = await createMiddleware(h)(event('tool_call', viaToolCall('web_fetch', { ...fetchPayload(), url }), { id: 'web_fetch', args: {} }), ctx('researcher'));
    return defined(/saved at (\S+): read it/.exec(defined(texts(defined(out ? out.result : undefined)).at(-2)))?.[1]);
  };
  const first = await fetch('https://example.com/first');
  usageHooks(h.pacer).agentEnd({}, ctx('researcher'));
  const retry = await fetch('https://example.com/retry');
  assert.deepEqual(warnings, []);
  assert.notEqual(retry, first);
  assert.match(await readFile(join(ws, first), 'utf8'), /example\.com\/first/);
  assert.match(await readFile(join(ws, retry), 'utf8'), /example\.com\/retry/);
});
