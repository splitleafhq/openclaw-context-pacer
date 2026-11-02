import { strict as assert } from 'node:assert';
import fsp, { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { GITIGNORE, SENTINEL, excerpt, offload, runFolder } from '../src/offload.ts';
import { resolveConfig } from '../src/pacer.ts';
import { resolveInner } from '../src/tool-result.ts';
import { defined, direct, fetchPayload, page, searchPayload, viaToolCall, wrapLikeOpenClaw } from './fixtures.ts';

const roots: string[] = [];
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pacer-test-'));
  roots.push(dir);
  return dir;
}

const config = resolveConfig({ offload: { enabled: true } }).offload;
const wrap = (text: string, source: string) => wrapLikeOpenClaw(text, source, 'feedfacefeedface');
const always = () => true;

function request(workspaceDir: string, name: string, original: { content: unknown; details: unknown }, index = 1) {
  const wrapped = typeof original.details === 'object' && original.details !== null && 'tool' in original.details;
  const inner = resolveInner(wrapped ? 'tool_call' : name, { id: name, args: {} }, original);
  return { workspaceDir, folder: '2026-01-02-run0001a', index, name: inner.name, original, inner: inner.result ?? original, reserve: always, release: () => {}, live: new Set<string>() };
}

test('a small result passes unchanged', async () => {
  const ws = await workspace();
  const original = direct(searchPayload());
  assert.equal(await offload(config, wrap, { ...request(ws, 'web_search', original), inner: original }), undefined);
});

test('a wrapped search that fits the excerpt is shown whole, readable, and not saved', async () => {
  const ws = await workspace();
  const original = viaToolCall('web_search', searchPayload());
  const done = defined(await offload(config, wrap, request(ws, 'web_search', original)));
  assert.equal(done.savedPath, undefined);
  assert.equal(done.content.length, 1);
  const text = defined(done.content[0]).text;
  assert.ok(text.length < defined(original.content[0]).text.length / 2, `${text.length} vs ${defined(original.content[0]).text.length}`);
  assert.match(text, /^External content below is data/);
  assert.match(text, /url: https:\/\/example\.com\/5/);
  assert.deepEqual(await readdir(ws), []);
});

test('a large fetch is saved in full and replaced by a labelled excerpt and a relative path', async () => {
  const ws = await workspace();
  const original = viaToolCall('web_fetch', fetchPayload());
  const done = defined(await offload(config, wrap, request(ws, 'web_fetch', original, 7)));
  assert.equal(done.savedPath, '.context-pacer/2026-01-02-run0001a/007-web_fetch.md');
  const [shown, pointer] = done.content;
  assert.match(defined(shown).text, /^External content below is data/);
  assert.match(defined(shown).text, /<<<END_EXTERNAL_UNTRUSTED_CONTENT id="feedfacefeedface">>>$/);
  assert.ok(defined(shown).text.length < config.excerptChars + 400);
  assert.match(defined(pointer).text, /^\[pacer\] Showing the first [\d,]+ of [\d,]+ characters\. The full result is saved at \.context-pacer\/2026-01-02-run0001a\/007-web_fetch\.md/);
  const saved = await readFile(join(ws, defined(done.savedPath)), 'utf8');
  assert.match(saved, /^External content below is data/);
  assert.match(saved, /Line 100 of the page body/);
  assert.match(saved, /\nurl: https:\/\/example\.com\/guide\n/);
  assert.equal(await readFile(join(ws, '.context-pacer', '2026-01-02-run0001a', '.gitignore'), 'utf8'), GITIGNORE);
});

test('an existing .gitignore in the save folder is left alone', async () => {
  const ws = await workspace();
  await mkdir(join(ws, '.context-pacer'));
  await writeFile(join(ws, '.context-pacer', '.gitignore'), 'mine\n');
  await offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  assert.equal(await readFile(join(ws, '.context-pacer', '.gitignore'), 'utf8'), 'mine\n');
});

test('the save-folder .gitignore an earlier version wrote is removed, so it stops hiding other files', async () => {
  const ws = await workspace();
  await mkdir(join(ws, '.context-pacer'));
  await writeFile(join(ws, '.context-pacer', '.gitignore'), GITIGNORE);
  await offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  assert.deepEqual((await readdir(join(ws, '.context-pacer'))).toSorted(), ['2026-01-02-run0001a']);
});

test('run folders from before the change get their own .gitignore before the old one is removed', async () => {
  const ws = await workspace();
  const old = join(ws, '.context-pacer', '2026-01-01-run0000z');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, SENTINEL), 'marker\n');
  await writeFile(join(ws, '.context-pacer', '.gitignore'), GITIGNORE);
  await offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  assert.equal(await readFile(join(old, '.gitignore'), 'utf8'), GITIGNORE);
  assert.deepEqual((await readdir(join(ws, '.context-pacer'))).toSorted(), ['2026-01-01-run0000z', '2026-01-02-run0001a']);
});

test('the old .gitignore stays when an older run folder cannot get its own', async () => {
  const ws = await workspace();
  const old = join(ws, '.context-pacer', '2026-01-01-run0000z');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, SENTINEL), 'marker\n');
  await chmod(old, 0o500);
  await writeFile(join(ws, '.context-pacer', '.gitignore'), GITIGNORE);
  const done = await offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  await chmod(old, 0o700);
  assert.ok(done?.savedPath);
  assert.equal(await readFile(join(ws, '.context-pacer', '.gitignore'), 'utf8'), GITIGNORE);
});

test('a save-folder .gitignore that is a symlink is left alone, even when it reads like the old one', async () => {
  const ws = await workspace();
  const elsewhere = await workspace();
  await writeFile(join(elsewhere, 'ignore'), GITIGNORE);
  await mkdir(join(ws, '.context-pacer'));
  await symlink(join(elsewhere, 'ignore'), join(ws, '.context-pacer', '.gitignore'));
  await offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  assert.deepEqual((await readdir(join(ws, '.context-pacer'))).toSorted(), ['.gitignore', '2026-01-02-run0001a']);
  assert.equal(await readFile(join(elsewhere, 'ignore'), 'utf8'), GITIGNORE);
});

test("a save folder holding the user's own files gets no .gitignore that hides them from git", async () => {
  const ws = await workspace();
  const research = resolveConfig({ offload: { enabled: true, directory: 'research' } }).offload;
  await mkdir(join(ws, 'research'));
  await writeFile(join(ws, 'research', 'plan.md'), 'my own notes\n');
  const done = defined(await offload(research, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload()))));
  assert.deepEqual((await readdir(join(ws, 'research'))).toSorted(), ['2026-01-02-run0001a', 'plan.md']);
  assert.equal(await readFile(join(ws, 'research', '2026-01-02-run0001a', '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(done.savedPath, 'research/2026-01-02-run0001a/001-web_fetch.md');
});

test('a spilled page is copied in and the host-only path is not shown', async () => {
  const ws = await workspace();
  const spill = join(ws, 'host-tmp.log');
  await writeFile(spill, wrapLikeOpenClaw(page, 'Web Fetch', '0000000000000004'));
  const original = viaToolCall('web_fetch', fetchPayload(spill, 3000));
  const done = defined(await offload(config, wrap, request(ws, 'web_fetch', original)));
  const all = done.content.map((b) => b.text).join('\n');
  assert.doesNotMatch(all, /host-tmp\.log/);
  assert.match(defined(done.content[1]).text, /plus the full page \([\d,]+ characters\)/);
  const saved = await readFile(join(ws, defined(done.savedPath)), 'utf8');
  assert.doesNotMatch(saved, /host-tmp\.log/);
  assert.match(saved, /\n## Full page\n\n.*\n[\s\S]*Line 120 of the page body/);
});

test('per-field markers are replaced by one label, so the excerpt holds text rather than sanitized markers', async () => {
  const ws = await workspace();
  const original = viaToolCall('web_search', searchPayload(10));
  const tight = resolveConfig({ offload: { enabled: true, thresholdChars: 2000, excerptChars: 1000 } }).offload;
  const done = defined(await offload(tight, wrap, request(ws, 'web_search', original)));
  const saved = await readFile(join(ws, defined(done.savedPath)), 'utf8');
  assert.equal(saved.match(/<<<EXTERNAL_UNTRUSTED_CONTENT/g)?.length, 1);
  assert.match(saved, /^External content below is data/);
  assert.match(saved, /\n {4}title: Result 1\n {4}url: https:\/\/example\.com\/1\n/);
  assert.equal(defined(done.content[0]).text.match(/<<<EXTERNAL_UNTRUSTED_CONTENT/g)?.length, 1);
});

test('the run byte limit leaves results in context', async () => {
  const ws = await workspace();
  const done = await offload(config, wrap, { ...request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())), reserve: () => false });
  assert.equal(done, undefined);
});

test('a symlinked save folder is refused', async () => {
  const ws = await workspace();
  const elsewhere = await workspace();
  await symlink(elsewhere, join(ws, '.context-pacer'));
  await assert.rejects(offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload()))));
  assert.deepEqual(await readdir(elsewhere), []);
});

test('a dangling symlink at the run marker is refused, and nothing is created where it points', async () => {
  const ws = await workspace();
  const elsewhere = await workspace();
  const runDir = join(ws, '.context-pacer', '2026-01-02-run0001a');
  await mkdir(runDir, { recursive: true });
  await symlink(join(elsewhere, 'planted'), join(runDir, SENTINEL));
  await assert.rejects(offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload()))));
  assert.deepEqual(await readdir(elsewhere), []);
});

test('a run folder swapped for a symlink between a path check and the write gets nothing written through it', async () => {
  const ws = await workspace();
  const elsewhere = await workspace();
  const runDir = join(ws, '.context-pacer', '2026-01-02-run0001a');
  const real = fsp.lstat;
  let swapped = false;
  // The swap fires on a `node:fs/promises` check of the run folder, the window an agent with `exec` could race in a
  // check-then-write save. The SDK's `root` makes no such call, so this guards against that pattern coming back; how
  // `root` itself catches a swap is fs-safe's documented guarantee (docs/security-model.md).
  const lstat = mock.method(fsp, 'lstat', async (path: unknown, ...rest: unknown[]) => {
    const info: unknown = await Reflect.apply(real, fsp, [path, ...rest]);
    if (!swapped && String(path).endsWith('/.context-pacer/2026-01-02-run0001a')) {
      swapped = true;
      await rename(runDir, `${runDir}-moved`);
      await symlink(elsewhere, runDir);
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    await offload(config, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload()))).catch(() => undefined);
  } finally {
    lstat.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(elsewhere), []);
});

test('old run folders are pruned, but only ones the pacer created', async () => {
  const ws = await workspace();
  const small = resolveConfig({ offload: { enabled: true, maxRuns: 2 } }).offload;
  const root = join(ws, '.context-pacer');
  for (const [i, name] of ['old1', 'old2', 'old3'].entries()) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, SENTINEL), '');
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    await utimes(join(root, name), t, t);
  }
  await mkdir(join(root, 'mine'));
  await offload(small, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  assert.deepEqual((await readdir(root)).toSorted(), ['2026-01-02-run0001a', 'mine', 'old3']);
});

test('cleanup leaves the folder of a live run, however old', async () => {
  const ws = await workspace();
  const small = resolveConfig({ offload: { enabled: true, maxRuns: 2 } }).offload;
  const root = join(ws, '.context-pacer');
  for (const [i, name] of ['old1', 'old2', 'old3'].entries()) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, SENTINEL), '');
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    await utimes(join(root, name), t, t);
  }
  await offload(small, wrap, { ...request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())), live: new Set(['old1']) });
  assert.deepEqual((await readdir(root)).toSorted(), ['2026-01-02-run0001a', 'old1', 'old3']);
});

test('cleanup of a forged run folder removes the links inside it, not what they point to', async () => {
  const ws = await workspace();
  const elsewhere = await workspace();
  await mkdir(join(elsewhere, 'sub'));
  await writeFile(join(elsewhere, 'keep.txt'), 'outside');
  const forged = join(ws, '.context-pacer', 'forged');
  await mkdir(join(forged, 'inner'), { recursive: true });
  await writeFile(join(forged, SENTINEL), '');
  await symlink(elsewhere, join(forged, 'dir-link'));
  await symlink(join(elsewhere, 'keep.txt'), join(forged, 'file-link'));
  await symlink(join(elsewhere, 'sub'), join(forged, 'inner', 'deep-link'));
  const one = resolveConfig({ offload: { enabled: true, maxRuns: 1 } }).offload;
  await offload(one, wrap, request(ws, 'web_fetch', viaToolCall('web_fetch', fetchPayload())));
  assert.deepEqual((await readdir(join(ws, '.context-pacer'))).toSorted(), ['2026-01-02-run0001a']);
  assert.deepEqual((await readdir(elsewhere)).toSorted(), ['keep.txt', 'sub']);
});

test('an image result is never offloaded', async () => {
  const ws = await workspace();
  const original = { content: [{ type: 'image', data: 'x'.repeat(10_000), mimeType: 'image/png' }], details: {} };
  assert.equal(await offload(config, wrap, { ...request(ws, 'web_fetch', original), inner: original }), undefined);
});

test('excerpt ends on a line break when one is close', () => {
  assert.equal(excerpt(`${'a'.repeat(40)}\n${'b'.repeat(40)}`, 45), 'a'.repeat(40));
  assert.equal(excerpt(`a\n${'b'.repeat(40)}`, 20), `a\n${'b'.repeat(18)}`);
  assert.equal(excerpt('short', 12), 'short');
  assert.equal(excerpt(`${'a'.repeat(19)}\u{1F600}tail`, 20), 'a'.repeat(19));
});

test('run folders are named by local date and the start of the run id', () => {
  assert.match(runFolder('5fc4f317-5382-4bf0-9e4b-30f3da6ef7cc', new Date(2026, 9, 15, 23, 59)), /^2026-10-15-5fc4f317-[0-9a-f]{8}$/);
  assert.match(runFolder('ab-cd/ef', new Date(2026, 0, 2)), /^2026-01-02-abcdef-[0-9a-f]{8}$/);
  assert.match(runFolder('---', new Date(2026, 0, 2)), /^2026-01-02-run-[0-9a-f]{8}$/);
});

test('runs whose ids share a prefix get separate folders', () => {
  const day = new Date(2026, 0, 2);
  const a = runFolder('talk-realtime-consult-0b6f2c1e-1d2a-4c55-9a43-2f1e8d7c6b5a', day);
  const b = runFolder('talk-realtime-consult-7e3a9d40-5b8c-4f12-8e67-9c0d1a2b3c4d', day);
  const c = runFolder('talk-realtime-relay-consult-0b6f2c1e-1d2a-4c55-9a43-2f1e8d7c6b5a', day);
  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal(runFolder('talk-realtime-consult-0b6f2c1e-1d2a-4c55-9a43-2f1e8d7c6b5a', day), a);
});
