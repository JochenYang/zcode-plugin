// Output budgets (CONTRACTS.md §11). The host shows the model at most 50 000
// bytes of a tool result and silently drops the rest (zcode-facts.md §2), so
// every rendered result is fitted to a token budget and then hard-capped in
// bytes by cutting whole lines from the end and appending a marker.
export const BYTES_PER_TOKEN = 4;
// Decimal kilobytes on purpose: the host limit is 50 000 (not 51 200) bytes.
export const MAX_OUTPUT_BYTES = 45_000;

// CJK text is ~3 bytes per character but ~1 token per character; a plain bytes/4 undercounts it by ~25%.
const WIDE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

/** Token estimate of `text`: wide (CJK) characters count 1 each, remaining UTF-8 bytes / 4, rounded up. */
export function estimateTokens(text) {
  const s = text === undefined || text === null ? '' : String(text);
  let wide = 0;
  for (const _ of s.matchAll(WIDE)) wide++;
  return Math.ceil(wide + Math.max(0, Buffer.byteLength(s, 'utf8') - wide * 3) / BYTES_PER_TOKEN);
}

/**
 * Keep the longest prefix of `lines` whose joined text fits `maxTokens`.
 * Lines are never split. `maxTokens` may be Infinity to keep everything; a
 * negative budget simply means nothing fits.
 *
 * @param {string[]} lines
 * @param {{ maxTokens?: number }} [options]
 * @returns {{ lines: string[], truncated: boolean }}
 */
export function fitLines(lines, { maxTokens = Infinity } = {}) {
  if (!Array.isArray(lines)) throw new TypeError(`fitLines: "lines" must be an array (got ${describe(lines)})`);
  if (maxTokens !== Infinity && !Number.isInteger(maxTokens)) {
    throw new TypeError(`fitLines: "maxTokens" must be an integer or Infinity (got ${describe(maxTokens)})`);
  }
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(String(line), 'utf8');
    const next = kept.length === 0 ? lineBytes : bytes + 1 + lineBytes; // joined with '\n'
    if (Math.ceil(next / BYTES_PER_TOKEN) > maxTokens) return { lines: kept, truncated: true };
    kept.push(String(line));
    bytes = next;
  }
  return { lines: kept, truncated: false };
}

/**
 * Hard byte cap: keep whole lines from the start while the result (plus the
 * marker) fits `maxBytes`; when anything is dropped, append `note` built from
 * the number of kept and total lines. The first line always yields to the note
 * when it alone is too large.
 *
 * @param {string[]} lines
 * @param {{ maxBytes?: number, note?: string | ((shown: number, total: number) => string) }} [options]
 * @returns {{ lines: string[], truncated: boolean }}
 */
export function capLines(lines, { maxBytes = MAX_OUTPUT_BYTES, note = (shown, total) => `(${shown} of ${total} lines shown; output truncated)` } = {}) {
  if (!Array.isArray(lines)) throw new TypeError(`capLines: "lines" must be an array (got ${describe(lines)})`);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(`capLines: "maxBytes" must be a positive integer (got ${describe(maxBytes)})`);
  }
  const total = Buffer.byteLength(lines.join('\n'), 'utf8');
  if (total <= maxBytes) return { lines: lines.slice(), truncated: false };
  const placeholder = typeof note === 'function' ? note(9999, 9999) : note;
  const noteBytes = (s) => Buffer.byteLength(String(s), 'utf8');
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    const next = kept.length === 0 ? noteBytes(line) : bytes + 1 + noteBytes(line);
    // Reserve room for the widest note the final counts can produce.
    if (next + 1 + noteBytes(placeholder) > maxBytes) break;
    kept.push(String(line));
    bytes = next;
  }
  const finalNote = typeof note === 'function' ? note(kept.length, lines.length) : note;
  return { lines: [...kept, finalNote], truncated: true };
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
