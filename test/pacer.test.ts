import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULTS, Pacer, appendStatus, resolveConfig, statusLine } from '../src/pacer.ts';
import { defined } from './fixtures.ts';

test('only configured agents are paced', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  assert.equal(pacer.applies('researcher'), true);
  assert.equal(pacer.applies('main'), false);
  assert.equal(pacer.applies(undefined), false);
});

test('does nothing until agents are configured', () => {
  assert.equal(new Pacer(resolveConfig(undefined)).applies('researcher'), false);
  assert.equal(new Pacer(resolveConfig({ agents: 'researcher' })).applies('researcher'), false);
  assert.equal(new Pacer(resolveConfig({ agents: [] })).applies('researcher'), false);
});

test('falls back to an approximate share from request size, and prefers reported usage', () => {
  const pacer = new Pacer(DEFAULTS);
  pacer.recordUsage('r1', 100_000, 70_000, true);
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /about 70% of budget \(approx\)\. Context is filling up/);
  pacer.recordUsage('r1', undefined, 50_000);
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /about 50% of budget\./);
  pacer.recordUsage('r1', undefined, 45_000, true);
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /about 50% of budget\./);
  pacer.recordUsage('r1', undefined, 60_000, true);
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /about 60% of budget \(approx\)/);
});

test('non-gathering tools pass unchanged', () => {
  const pacer = new Pacer(DEFAULTS);
  assert.equal(pacer.onToolResult('r1', 'read', { path: 'memory/a.md' }), undefined);
  assert.equal(pacer.onToolResult('r1', 'exec', {}), undefined);
});

test('counts gathering results and asks for a note after notes.everyResults', () => {
  const pacer = new Pacer(resolveConfig({ notes: { pathContains: 'notes/', everyResults: 3 } }));
  assert.match(defined(pacer.onToolResult('r1', 'web_search', {})), /1 gathering result so far · no notes written yet\.$/);
  pacer.onToolResult('r1', 'web_fetch', {});
  const third = defined(pacer.onToolResult('r1', 'web_fetch', {}));
  assert.match(third, /3 gathering results so far/);
  assert.match(third, /Add what these sources showed to your notes/);
});

test('a write under the notes path resets the count; other writes do not', () => {
  const pacer = new Pacer(resolveConfig({ notes: { pathContains: 'notes/', everyResults: 2 } }));
  pacer.onToolResult('r1', 'web_fetch', {});
  pacer.onToolResult('r1', 'write', { path: 'drafts/x.md' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /no notes written yet\. Add/);
  pacer.onToolResult('r1', 'write', { path: 'notes/topic.md' });
  const line = defined(pacer.onToolResult('r1', 'web_search', {}));
  assert.match(line, /last note 1 result ago\.$/);
});

test('notes.pathContains decides which writes count as notes', () => {
  const pacer = new Pacer(resolveConfig({ notes: { pathContains: 'notes/', everyResults: 1 } }));
  pacer.onToolResult('r1', 'write', { path: 'memory/2026-10-15.md' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /no notes written yet/);
  pacer.onToolResult('r1', 'write', { path: 'notes/topic.md' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /last note 1 result ago/);
});

test('reports context share and says to finish once past wrapUpContextFraction', () => {
  const pacer = new Pacer(resolveConfig({ notes: { pathContains: 'notes/' }, wrapUpContextFraction: 0.6 }));
  pacer.recordUsage('r1', 100_000, 40_000);
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 40% of budget\.$/);
  pacer.recordUsage('r1', undefined, 65_000);
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /about 65% of budget\. Context is filling up/);
});

test('omits the context share when OpenClaw reported no usage', () => {
  const line = statusLine({ gathers: 2, notes: 1, sinceNote: 1 }, DEFAULTS);
  assert.doesNotMatch(line, /context/);
});

test('runs are separate and bounded', () => {
  const pacer = new Pacer(resolveConfig({ maxTrackedRuns: 2 }));
  pacer.onToolResult('a', 'web_fetch', {});
  pacer.onToolResult('b', 'web_fetch', {});
  pacer.onToolResult('c', 'web_fetch', {});
  assert.equal(pacer.trackedRuns, 2);
  assert.match(defined(pacer.onToolResult('c', 'web_fetch', {})), /2 gathering results/);
  pacer.end('c');
  assert.equal(pacer.trackedRuns, 1);
});

test('a run with recent results is not dropped for newer runs', () => {
  const pacer = new Pacer(resolveConfig({ maxTrackedRuns: 2 }));
  pacer.onToolResult('a', 'web_fetch', {});
  pacer.onToolResult('b', 'web_fetch', {});
  pacer.onToolResult('a', 'web_fetch', {});
  pacer.onToolResult('c', 'web_fetch', {});
  assert.match(defined(pacer.onToolResult('a', 'web_fetch', {})), /3 gathering results/);
});

test('invalid config falls back to defaults and clamps numbers', () => {
  const config = resolveConfig({ agents: [''], notes: { everyResults: 999, pathContains: '' }, wrapUpContextFraction: 'x' });
  assert.deepEqual(config.agents, []);
  assert.equal(config.notes.everyResults, 20);
  assert.equal(config.wrapUpContextFraction, DEFAULTS.wrapUpContextFraction);
  assert.equal(config.notes.pathContains, undefined);
});

test('appendStatus adds a text block and keeps the original content', () => {
  const result = { content: [{ type: 'text', text: 'page' }], details: { url: 'u' } };
  const out = appendStatus(result, '[pacer] x.');
  assert.deepEqual(out.content, [{ type: 'text', text: 'page' }, { type: 'text', text: '[pacer] x.' }]);
  assert.deepEqual(out.details, { url: 'u' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'page' }]);
});

test('without a notes path the line never mentions notes, and the finish advice drops "from your notes"', () => {
  const pacer = new Pacer(resolveConfig({ notes: { everyResults: 1 } }));
  pacer.onToolResult('r1', 'write', { path: 'notes/topic.md' });
  const first = defined(pacer.onToolResult('r1', 'web_fetch', {}));
  assert.equal(first, '[pacer] 1 gathering result so far.');
  pacer.recordUsage('r1', 100_000, 70_000);
  assert.equal(defined(pacer.onToolResult('r1', 'web_fetch', {})), '[pacer] 2 gathering results so far · context about 70% of budget. Context is filling up: stop gathering and write the answer.');
});

test('a run keeps one saved-file folder name', () => {
  const pacer = new Pacer(DEFAULTS);
  let made = 0;
  const make = () => `folder-${++made}`;
  assert.equal(pacer.folderFor('r1', make), 'folder-1');
  assert.equal(pacer.folderFor('r1', make), 'folder-1');
  assert.equal(pacer.folderFor('r2', make), 'folder-2');
});
