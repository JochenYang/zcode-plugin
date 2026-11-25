// The text prefilter of the property-read scan (CONTRACTS.md §8 "property reads").
//
// `obj.name` or `obj?.name`, with a short gap allowed between the dot and the name: a run of
// whitespace, then up to eight comments, each followed by a run of whitespace. Every piece is
// bounded — a run of whitespace at 40 characters, a block comment at 200, a line comment at 1000
// — and longer ones between a dot and a name lose the read. The bounds are the point: this runs
// over every JS/TS file of the project on each search, and the step that reads the files is
// bounded by bytes read, which does not see what a pattern costs. A gap that could run on to the
// end of the file was quadratic on text like `a. /* x */ b; ` repeated (400 KB took 5 s) and on
// a line comment that has no newline after it (a one-line file: 800 KB took 38 s); whitespace as
// a repeatable piece was exponential on `a.` followed by a run of spaces (all 2026-11-25). A
// whitespace character also has exactly one place it can belong to, which is what keeps the
// backtracking from branching.
// Not `...name`; not a call (`obj.name(` is in the index). Over-matching costs a parse that
// decides, under-matching loses a read — which is what `tests/graph/propertyReads.test.mjs` pins
// about this pattern, since it is written with escaped backslashes inside a template literal.
export const propertyReadNeedle = (name) => new RegExp(
  `(?:(?<!\\.)\\.|\\?\\.)(?:\\s{1,40})?(?:(?:/\\*(?:[^*]|\\*(?!/)){0,200}\\*/|//[^\\n]{0,1000}\\n)(?:\\s{1,40})?){0,8}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$(])`,
  'g',
);
