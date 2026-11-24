// Budget helpers (CONTRACTS.md §11): token estimate, line fitting, byte cap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_TOKEN, MAX_OUTPUT_BYTES, capLines, estimateTokens, fitLines } from '../../src/render/budget.mjs';

const bytes = (s) => Buffer.byteLength(s, 'utf8');

describe('estimateTokens', () => {
  test('is UTF-8 bytes / 4 rounded up; empty input is 0', () => {
    assert.equal(BYTES_PER_TOKEN, 4);
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('a'.repeat(BYTES_PER_TOKEN * 10)), 10);
    assert.equal(estimateTokens('é'), 1); // 2 bytes
    assert.equal(estimateTokens('中'.repeat(3)), 3); // 9 bytes -> 3 tokens
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });
});

describe('fitLines', () => {
  test('keeps every line within the budget and reports no truncation', () => {
    const lines = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)];
    const out = fitLines(lines, { maxTokens: estimateTokens(lines.join('\n')) });
    assert.deepEqual(out, { lines, truncated: false });
    assert.deepEqual(fitLines(lines), { lines, truncated: false }, 'no budget keeps everything');
    assert.deepEqual(fitLines([], { maxTokens: 0 }), { lines: [], truncated: false });
  });

  test('drops whole lines from the end once the joined text would exceed maxTokens', () => {
    const lines = ['x'.repeat(8), 'y'.repeat(8), 'z'.repeat(8)];
    // joined: 8 + 1 + 8 = 17 bytes -> 5 tokens for two lines; three lines are 26 bytes -> 7 tokens
    assert.deepEqual(fitLines(lines, { maxTokens: 5 }), { lines: lines.slice(0, 2), truncated: true });
    assert.deepEqual(fitLines(lines, { maxTokens: 7 }), { lines, truncated: false });
    assert.deepEqual(fitLines(lines, { maxTokens: 4 }), { lines: lines.slice(0, 1), truncated: true });
  });

  test('measures the joined text, not the sum of per-line tokens', () => {
    // three 2-byte lines: joined 8 bytes -> 2 tokens (per-line sums would say 3)
    assert.deepEqual(fitLines(['ab', 'cd', 'ef'], { maxTokens: 2 }), { lines: ['ab', 'cd', 'ef'], truncated: false });
    assert.deepEqual(fitLines(['ab', 'cd', 'ef'], { maxTokens: 1 }), { lines: ['ab'], truncated: true });
  });

  test('a first line larger than the budget yields no lines; a negative budget too', () => {
    assert.deepEqual(fitLines(['x'.repeat(100)], { maxTokens: 3 }), { lines: [], truncated: true });
    assert.deepEqual(fitLines(['x'.repeat(100)], { maxTokens: 0 }), { lines: [], truncated: true });
    assert.deepEqual(fitLines(['ab'], { maxTokens: -5 }), { lines: [], truncated: true });
    assert.deepEqual(fitLines([], { maxTokens: -5 }), { lines: [], truncated: false });
  });

  test('rejects invalid input', () => {
    assert.throws(() => fitLines('nope'), /fitLines: "lines" must be an array/);
    assert.throws(() => fitLines([], { maxTokens: 1.5 }), /fitLines: "maxTokens"/);
    assert.throws(() => fitLines([], { maxTokens: '5' }), /fitLines: "maxTokens"/);
    assert.throws(() => fitLines([], { maxTokens: NaN }), /fitLines: "maxTokens"/);
  });
});

describe('capLines', () => {
  test('passes through when the text fits maxBytes', () => {
    const lines = ['a', 'b', 'c'];
    const out = capLines(lines, { maxBytes: 100 });
    assert.deepEqual(out, { lines, truncated: false });
    assert.notEqual(out.lines, lines, 'returns a copy');
  });

  test('cuts whole lines and appends the note with kept/total counts', () => {
    const lines = ['x'.repeat(30), 'y'.repeat(30), 'z'.repeat(30)];
    const out = capLines(lines, { maxBytes: 85, note: (shown, total) => `(${shown} of ${total} lines)` });
    assert.equal(out.truncated, true);
    assert.deepEqual(out.lines, [lines[0], lines[1], '(2 of 3 lines)']);
    assert.ok(bytes(out.lines.join('\n')) <= 85);
  });

  test('yields only the note when the first line alone is too large', () => {
    const out = capLines(['x'.repeat(500), 'y'], { maxBytes: 50, note: 'cut' });
    assert.deepEqual(out, { lines: ['cut'], truncated: true });
  });

  test('honours a fixed note string and validates input', () => {
    const out = capLines(['aaa', 'bbb', 'ccc'], { maxBytes: 10, note: 'TRUNCATED' });
    assert.deepEqual(out.lines, ['TRUNCATED']);
    assert.throws(() => capLines('nope'), /capLines: "lines" must be an array/);
    assert.throws(() => capLines([], { maxBytes: 0 }), /capLines: "maxBytes"/);
  });

  test('default cap keeps output at or below MAX_OUTPUT_BYTES with huge lines', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `${i} ${'x'.repeat(200)}`);
    const out = capLines(lines);
    assert.equal(out.truncated, true);
    assert.ok(out.lines.length > 100, 'keeps as many lines as fit');
    assert.match(out.lines.at(-1), /^\(\d+ of \d+ lines shown; output truncated\)$/);
    assert.ok(bytes(out.lines.join('\n')) <= MAX_OUTPUT_BYTES);
    assert.equal(MAX_OUTPUT_BYTES, 45_000);
  });
});
