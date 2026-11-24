; TSX shares the TypeScript locals: same binding rules, JSX only adds element and
; attribute nodes whose identifiers are plain (identifier) references already.
; The base file is spliced in front by grammars/loader.mjs (queryTextFor).
; inherits: typescript

; JSX component and member names do not bind anything; the expression children
; (`{expr}`, attribute values) are ordinary identifiers covered by the base query.
