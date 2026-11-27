import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULTS, Pacer, resolveConfig } from '../src/pacer.ts';
import { isErrorResult, readable, resolveInner, spillPath, textOf, unwrapExternal } from '../src/tool-result.ts';
import { defined, direct, failedCall, fetchPayload, searchPayload, viaToolCall, wrapLikeOpenClaw } from './fixtures.ts';

test('a direct call resolves to itself', () => {
  const result = direct(searchPayload());
  const inner = resolveInner('web_search', { query: 'q' }, result);
  assert.equal(inner.name, 'web_search');
  assert.equal(inner.wrapped, false);
  assert.equal(inner.result, result);
});

test('a tool_call resolves to the tool that ran and its own result', () => {
  const result = viaToolCall('web_fetch', fetchPayload());
  const inner = resolveInner('tool_call', { id: 'web_fetch', args: { url: 'https://example.com/guide' } }, result);
  assert.equal(inner.name, 'web_fetch');
  assert.equal(inner.wrapped, true);
  assert.deepEqual(inner.args, { url: 'https://example.com/guide' });
  assert.equal(textOf(defined(inner.result)), JSON.stringify(fetchPayload(), null, 2));
});

test('a failed tool_call takes its name from the catalog id', () => {
  const inner = resolveInner('tool_call', { id: 'openclaw:core:web_fetch', args: {} }, failedCall);
  assert.equal(inner.name, 'web_fetch');
  assert.equal(inner.result, undefined);
  assert.equal(isErrorResult(failedCall), true);
});

test('the pacer counts gathering results that arrive through tool_call', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const inner = resolveInner('tool_call', { id: 'web_search', args: { query: 'q' } }, viaToolCall('web_search', searchPayload()));
  assert.match(defined(pacer.onToolResult('r1', inner.name, inner.args)), /1 gathering result so far/);
  assert.equal(pacer.onToolResult('r1', 'tool_call', {}), undefined);
});

test('readable turns JSON into lines and keeps page text on its own lines', () => {
  const text = readable(JSON.stringify({ url: 'https://example.com', status: 200, text: 'a\nb', results: [{ title: 't' }] }));
  assert.equal(text, 'url: https://example.com\nstatus: 200\ntext:\na\nb\nresults:\n  - (1)\n    title: t');
  assert.equal(readable('plain text'), 'plain text');
  assert.equal(readable('{not json'), '{not json');
});

test('spillPath accepts only an absolute path from details.spill', () => {
  assert.equal(spillPath(direct(fetchPayload('/tmp/openclaw-web-fetch-1.log'))), '/tmp/openclaw-web-fetch-1.log');
  assert.equal(spillPath(direct(fetchPayload())), undefined);
  assert.equal(spillPath({ details: { spill: { path: 'relative.log' } } }), undefined);
});

test('offload settings default to off and stay inside the workspace', () => {
  assert.equal(DEFAULTS.offload.enabled, false);
  assert.equal(resolveConfig({ offload: { enabled: 'yes' } }).offload.enabled, false);
  assert.equal(resolveConfig({ offload: true }).offload.enabled, false);
  for (const bad of ['../up', '/abs', 'a/../b', '', 'a b', '.', 'a/./b']) {
    assert.equal(resolveConfig({ offload: { directory: bad } }).offload.directory, '.context-pacer', bad);
  }
  assert.equal(resolveConfig({ offload: { directory: 'work/results/' } }).offload.directory, 'work/results');
  assert.equal(resolveConfig({ offload: { directory: '.saved/run-files' } }).offload.directory, '.saved/run-files');
  const c = resolveConfig({ offload: { thresholdChars: 2000, excerptChars: 5000 } });
  assert.equal(c.offload.excerptChars, 1000);
});

test('unwrapExternal removes one OpenClaw wrapper, with or without its warning, and keeps what follows', () => {
  assert.equal(unwrapExternal(wrapLikeOpenClaw('Result 1', 'Web Search', '1234567890abcdef', false)), 'Result 1');
  const page = `${wrapLikeOpenClaw('line one\nline two', 'Web Fetch', 'fedcba0987654321')}\n\n[Showing truncated web_fetch content.]`;
  assert.equal(unwrapExternal(page), 'line one\nline two\n\n[Showing truncated web_fetch content.]');
  assert.equal(unwrapExternal('plain text'), 'plain text');
  assert.equal(unwrapExternal('<<<EXTERNAL_UNTRUSTED_CONTENT id="not-hex">>>\nSource: x\n---\ny'), '<<<EXTERNAL_UNTRUSTED_CONTENT id="not-hex">>>\nSource: x\n---\ny');
});
