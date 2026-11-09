/**
 * Reading tool results the way OpenClaw hands them to middleware.
 *
 * With Tool Search on (OpenClaw's default when `tools.toolSearch` is unset), deferred tools such as `web_search` and
 * `web_fetch` run through Tool Search's call control: `dispatch_action`, earlier named `tool_call` (OpenClaw 2026.11.2
 * docs/tools/tool-search.md, "Upgrading"). Middleware then sees that name as `toolName`, `args: { id, args }` and
 * `details: { tool: { name, … }, result: { content, details } }`. In 2026.10.3 the model sees that whole object as
 * escaped JSON, with the page text twice (in `content` and in `details`); upstream #169537 drops `details` from it.
 */
/** Tool Search's call control: its earlier name and its current one. */
export const TOOL_CALL = 'tool_call';
export const DISPATCH_ACTION = 'dispatch_action';
const CALL_CONTROLS = new Set([TOOL_CALL, DISPATCH_ACTION]);
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The tool that actually ran and its own result, whether it was called directly or through the call control. */
export function resolveInner(toolName, args, result) {
    if (!CALL_CONTROLS.has(toolName)) {
        return { name: toolName, args, result, wrapped: false };
    }
    const call = isRecord(args) ? args : {};
    const innerArgs = isRecord(call.args) ? call.args : {};
    const details = result.details;
    // Successful calls carry the resolved tool; failed ones carry the control's name as `tool` and an error string.
    if (isRecord(details) && isRecord(details.tool) && typeof details.tool.name === 'string') {
        const inner = isRecord(details.result) && Array.isArray(details.result.content) ? details.result : undefined;
        return { name: details.tool.name, args: innerArgs, result: inner, wrapped: true };
    }
    // The model may pass a bare name or a catalog id such as "openclaw:core:web_fetch".
    const id = typeof call.id === 'string' ? call.id : '';
    return { name: id.slice(id.lastIndexOf(':') + 1) || toolName, args: innerArgs, wrapped: true };
}
/** All text blocks joined, or undefined when the result holds anything else (an image, say). */
export function textOf(result) {
    if (!Array.isArray(result.content)) {
        return undefined;
    }
    const parts = [];
    for (const block of result.content) {
        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
            return undefined;
        }
        parts.push(block.text);
    }
    return parts.join('\n');
}
// `wrapExternalContent` in 2026.10.3: an optional warning block, then a start marker, metadata lines, `---`, the text
// and an end marker. Wrapping text that already holds markers turns them into sanitized placeholders, so a result
// that will be labelled as a whole first loses its per-field wrappers.
const WRAPPED = /^(?:[^\n]*\n\n)?\n?<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\n(?:[^\n]*\n)*?---\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>/;
/** The text inside one OpenClaw external-content wrapper at the start of `value`, keeping anything after it. */
export function unwrapExternal(value) {
    const match = WRAPPED.exec(value);
    return match ? match[1] + value.slice(match[0].length) : value;
}
function render(value, indent, out, unwrap) {
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            if (isRecord(item) || Array.isArray(item)) {
                out.push(`${indent}- (${i + 1})`);
                render(item, `${indent}  `, out, unwrap);
            }
            else {
                out.push(`${indent}- ${scalar(item, unwrap)}`);
            }
        });
        return;
    }
    if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (isRecord(item) || Array.isArray(item)) {
                out.push(`${indent}${key}:`);
                render(item, `${indent}  `, out, unwrap);
                continue;
            }
            const text = scalar(item, unwrap);
            // Page text keeps its own lines, so `read` with offset and limit pages through it.
            if (text.includes('\n')) {
                out.push(`${indent}${key}:`, text);
            }
            else {
                out.push(`${indent}${key}: ${text}`);
            }
        }
        return;
    }
    out.push(`${indent}${scalar(value, unwrap)}`);
}
function scalar(value, unwrap) {
    return typeof value === 'string' && unwrap ? unwrapExternal(value) : String(value);
}
/**
 * JSON tool output as plain `key: value` lines with strings unescaped; any other text is returned as is. With
 * `unwrap`, OpenClaw's external-content wrappers are removed from each value, for a result the caller labels whole.
 */
export function readable(text, unwrap = false) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return unwrap ? unwrapExternal(text) : text;
    }
    try {
        const out = [];
        render(JSON.parse(trimmed), '', out, unwrap);
        return out.join('\n');
    }
    catch {
        return unwrap ? unwrapExternal(text) : text;
    }
}
/** True when OpenClaw labelled this result as untrusted external content. */
export function isExternal(result, text) {
    const details = result.details;
    if (isRecord(details) && isRecord(details.externalContent) && details.externalContent.untrusted === true) {
        return true;
    }
    return text.includes('<<<EXTERNAL_UNTRUSTED_CONTENT');
}
/** `details.spill.path` from a truncated `web_fetch`: the host file holding the full page. */
export function spillPath(result) {
    const details = result.details;
    if (!isRecord(details) || !isRecord(details.spill)) {
        return undefined;
    }
    const path = details.spill.path;
    return typeof path === 'string' && path.startsWith('/') ? path : undefined;
}
export function isErrorResult(result) {
    return isRecord(result.details) && (result.details.status === 'error' || result.details.status === 'failed');
}
