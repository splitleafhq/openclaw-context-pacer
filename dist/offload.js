/**
 * Offload: a large gathering result is saved in full to the workspace the agent's tools run in, where its sandbox can
 * read it, and the model sees an excerpt plus the file's path. This is the "restorable compression" pattern: nothing is
 * dropped, only moved out of context until the agent asks for it.
 *
 * Unless that workspace is read-only, the agent can write there too, so it can plant or swap in symlinks while a save runs. Every file
 * operation below it goes through OpenClaw's root-bounded file API (`root` from the plugin SDK), which refuses a
 * symlink at any point on the path, including one swapped in after a check.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { root } from 'openclaw/plugin-sdk/security-runtime';
import { isExternal, readable, spillPath, textOf } from './tool-result.js';
/** Marks run folders this plugin created; cleanup never touches a folder without it. */
export const SENTINEL = '.context-pacer-run';
/**
 * Written in every run folder this plugin creates, as OpenClaw puts one in each folder of staged inputs it creates
 * (2026.10.3 and 2026.10.4, src/media/staged-inputs.ts). Never written in `directory`, which can hold the user's own
 * files.
 */
export const GITIGNORE = '# Saved tool results from the context-pacer plugin; old run folders are deleted.\n*\n';
const MAX_SPILL_BYTES = 10_000_000;
// The agent can write in the run folder, so taken names are bounded rather than searched without end.
const MAX_NAME_TRIES = 100;
function pad(n) {
    return String(n).padStart(2, '0');
}
/**
 * `<YYYY-MM-DD>-<first 8 letters and digits of the run id>-<8 hex digits of its SHA-256>`, using the gateway's local
 * date. The hash is needed because OpenClaw run ids can share a long prefix, such as `talk-realtime-consult-<uuid>`
 * (2026.10.7, realtime-session-harness and gateway talk handlers).
 */
export function runFolder(runId, now) {
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hash = createHash('sha256').update(runId).digest('hex').slice(0, 8);
    return `${date}-${runId.replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'run'}-${hash}`;
}
/** Cuts at the last line break inside the limit when one is reasonably close, so the excerpt ends cleanly. */
export function excerpt(text, max) {
    if (text.length <= max) {
        return text;
    }
    const cut = text.lastIndexOf('\n', max);
    if (cut > max * 0.8) {
        return text.slice(0, cut);
    }
    // A lone high surrogate is malformed UTF-16, which a provider may reject.
    const high = text.charCodeAt(max - 1);
    return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}
/** Keeps the newest `maxRuns` folders this plugin created in `directory`, counting the current one, plus every live one. */
async function prune(workspace, directory, maxRuns, current, live) {
    const entries = await workspace.list(directory, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory && !entry.isSymbolicLink && entry.name !== current);
    const marked = await Promise.all(folders.map(async (entry) => ((await isMarked(workspace, `${directory}/${entry.name}`)) ? entry : undefined)));
    const ours = marked.filter((entry) => entry !== undefined).toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(ours
        .slice(Math.max(0, maxRuns - 1))
        .filter((old) => !live.has(old.name))
        .map((old) => workspace.remove(`${directory}/${old.name}`, { recursive: true, force: true })));
}
/** True when the folder carries this plugin's marker; a marker that is a symlink doesn't count. */
async function isMarked(workspace, folder) {
    try {
        return await workspace.exists(`${folder}/${SENTINEL}`);
    }
    catch {
        return false;
    }
}
function alreadyExists(error) {
    return error instanceof Error && 'code' in error && error.code === 'already-exists';
}
/** Leaves an existing file alone, including one the user wrote. With `mkdir` false, a missing folder stays missing. */
async function createIfAbsent(workspace, path, text, mkdir = true) {
    try {
        await workspace.create(path, text, { private: true, mkdir });
    }
    catch (error) {
        if (!alreadyExists(error)) {
            throw error;
        }
    }
}
/**
 * Creates `<base>.md`, or `<base>-2.md` and so on when that name is taken. With the conversation-access grant,
 * `agent_end` resets the run's counters, and a retried attempt keeps the run id and so the same folder (OpenClaw
 * 2026.10.7, dist/embedded-agent-*.mjs: each pass of the attempt loop reuses `params.runId`). `create` fails rather
 * than overwrite.
 */
async function createUnique(workspace, dir, base, text, n = 1) {
    const path = `${dir}/${base}${n === 1 ? '' : `-${n}`}.md`;
    try {
        await workspace.create(path, text, { private: true });
        return path;
    }
    catch (error) {
        if (!alreadyExists(error) || n >= MAX_NAME_TRIES) {
            throw error;
        }
    }
    return createUnique(workspace, dir, base, text, n + 1);
}
/**
 * Removes the blanket `.gitignore` earlier versions of this plugin wrote in `directory`. It must go because
 * `directory` can hold the user's own files and `*` keeps git from adding them. Run folders those versions created
 * have no `.gitignore` of their own, so each marked folder gets one first. Another run's save can prune a folder
 * meanwhile, so the backfill never recreates one, and the file goes only once every folder has its own. The root
 * API refuses symlinks, so a symlink there makes the read throw; any error (missing file, symlink, other) leaves
 * the file alone so the save is not disrupted.
 */
async function removeLegacyGitignore(workspace, directory) {
    const path = `${directory}/.gitignore`;
    try {
        const bytes = await workspace.readBytes(path);
        if (!Buffer.from(GITIGNORE).equals(bytes)) {
            return;
        }
        const entries = await workspace.list(directory, { withFileTypes: true });
        const backfill = await Promise.allSettled(entries
            .filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
            .map(async (entry) => {
            const folder = `${directory}/${entry.name}`;
            if (await isMarked(workspace, folder)) {
                await createIfAbsent(workspace, `${folder}/.gitignore`, GITIGNORE, false);
            }
        }));
        if (backfill.every((result) => result.status === 'fulfilled')) {
            await workspace.remove(path);
        }
    }
    catch {
        // leave the file alone
    }
}
async function readSpill(path) {
    try {
        const info = await stat(path);
        return info.isFile() && info.size <= MAX_SPILL_BYTES ? await readFile(path, 'utf8') : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Returns replacement content for a large result, or undefined to leave it as it is. A result is offloaded when the
 * text the model would see exceeds `thresholdChars`. Its readable form is saved, along with the full page when
 * `web_fetch` spilled one to a host-only file. When that readable form already fits in `excerptChars`, it is shown
 * whole and nothing is saved.
 */
export async function offload(config, wrap, req) {
    const visible = textOf(req.original);
    const innerText = textOf(req.inner);
    if (visible === undefined || innerText === undefined || visible.length <= config.thresholdChars) {
        return undefined;
    }
    const external = isExternal(req.inner, innerText) || isExternal(req.original, visible);
    const label = (text) => (external ? wrap(text, req.name) : text);
    let body = readable(innerText, external);
    const spill = spillPath(req.inner);
    const spillText = spill ? await readSpill(spill) : undefined;
    if (spill && spillText !== undefined) {
        body = body.split(spill).join('the "Full page" section of this file');
    }
    if (body.length <= config.excerptChars && spillText === undefined) {
        return { content: [{ type: 'text', text: label(body) }] };
    }
    // The saved text keeps OpenClaw's untrusted-content warning, as web_fetch's own saved output does.
    const saved = label(body) + (spillText === undefined ? '' : `\n\n## Full page\n\n${spillText}`);
    const bytes = Buffer.byteLength(saved, 'utf8');
    if (!req.reserve(bytes)) {
        return undefined;
    }
    const runDir = `${config.directory}/${req.folder}`;
    const base = `${String(req.index).padStart(3, '0')}-${req.name.replaceAll(/[^A-Za-z0-9_-]/g, '')}`;
    let savedPath;
    try {
        const workspace = await root(req.workspaceDir);
        await workspace.mkdir(runDir, { private: true });
        const marker = `${runDir}/${SENTINEL}`;
        if (!(await workspace.exists(marker))) {
            await createIfAbsent(workspace, `${runDir}/.gitignore`, GITIGNORE);
            await createIfAbsent(workspace, marker, 'Created by the context-pacer OpenClaw plugin; old run folders are deleted.\n');
            await removeLegacyGitignore(workspace, config.directory);
            await prune(workspace, config.directory, config.maxRuns, req.folder, req.live);
        }
        savedPath = await createUnique(workspace, runDir, base, saved);
    }
    catch (error) {
        req.release(bytes);
        throw error;
    }
    const shown = excerpt(body, config.excerptChars);
    const fullPage = spillText === undefined ? '' : `, plus the full page (${spillText.length.toLocaleString('en-US')} characters)`;
    const pointer = `[pacer] Showing the first ${shown.length.toLocaleString('en-US')} of ${body.length.toLocaleString('en-US')} characters${fullPage}. The full result is saved at ${savedPath}: read it with offset and limit if you need more.`;
    return { content: [{ type: 'text', text: label(shown) }, { type: 'text', text: pointer }], savedPath };
}
