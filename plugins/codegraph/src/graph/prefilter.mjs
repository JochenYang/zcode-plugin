// The text prefilter of the property-read scan (CONTRACTS.md §8 "property reads").
//
// `obj.name` or `obj?.name`, with a short gap allowed between the dot and the name: a run of
// whitespace, then up to eight comments, each followed by a run of whitespace. Every piece is
// bounded — a run of whitespace at 40 characters, a block comment at 200, a line comment at 1000
// — and longer ones between a dot and a name lose the read. The bounds are the point: this runs
// over every JS/TS file of the project, and the step that reads the files is bounded by bytes
// read, which does not see what a pattern costs. A gap that could run on to the end of the file
// was quadratic on text like `a. /* x */ b; ` repeated (400 KB took 5 s) and on a line comment
// that has no newline after it (a one-line file: 800 KB took 38 s); whitespace as a repeatable
// piece was exponential on `a.` followed by a run of spaces (all 2026-11-25). A whitespace
// character also has exactly one place it can belong to, which is what keeps the backtracking
// from branching.
//
// Two patterns share the dot and the gap, so that they agree on what may stand between the two:
// `propertyReadNeedle(name)` finds the reads of one name in a file; `dottedName` lists every name
// behind a dot in a file, which is what the scan remembers of a file between two searches.
//
// Not `...name`; not a call (`obj.name(` is in the index). Over-matching costs a parse that
// decides, under-matching loses a read — which is what `tests/graph/propertyReads.test.mjs` pins
// about these patterns, since they are written with escaped backslashes inside raw strings.
const DOT = String.raw`(?:(?<!\.)\.|\?\.)`;
const GAP = String.raw`(?:\s{1,40})?(?:(?:/\*(?:[^*]|\*(?!/)){0,200}\*/|//[^\n]{0,1000}\n)(?:\s{1,40})?){0,8}`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
// After the name: not a longer name, not `$`, and not a call (`obj.name(` is in the index).
const NOT_NAME = String.raw`(?![\w$(])`;
const literal = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every place `name` is read behind a dot or `?.`, as text: a global regular expression. */
export const propertyReadNeedle = (name) => new RegExp(`${DOT}${GAP}${literal(name)}${NOT_NAME}`, 'g');

/** Every name behind a dot or `?.`, as text; the name is the first capture. Over-matches freely. */
export const dottedName = new RegExp(`${DOT}${GAP}(${NAME})`, 'g');

// The same with no gap allowed. Matches do not overlap, and a gap can run on through what only
// looks like a comment (a `//` or `/*` inside a string) and swallow the reads that follow it on
// that line; this one cannot swallow a dot, since a match is a dot and one name. What a file
// holds is the union of the two.
export const dottedNameTight = new RegExp(`${DOT}(${NAME})`, 'g');

// A name on its own: not behind a dot, not `$`-prefixed, not the tail of a longer name. Where a
// name is the key of an object (`{ name: 1 }`, `{ name }`, `const { name } = row`) is a part of
// this, so what a file holds of these is the superset the scan works from for keys. It matches
// every other bare identifier too (a declaration, a parameter, an import); the parse decides.
export const bareName = new RegExp(String.raw`(?<![\w$.])(${NAME})`, 'g');
