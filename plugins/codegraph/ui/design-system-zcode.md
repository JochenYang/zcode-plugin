---
name: zcode
sources:
  - ZCode Desktop, out/plugin-sandbox/visualize.css (the "agent-facing contract" the bundled visualize skill is kept in sync with)
---

# zcode

ZCode's own theme contract for UI rendered inside the app, taken verbatim from the stylesheet the
app ships for its sandboxed views. Every color is a theme variable that resolves from the running
app (`--color-*`) and falls back to the light / dark pair listed here; a view never hardcodes a
palette. Checked with the design skill's `design-lint.mjs`.

## Colors

Light / dark are the fallback pair the contract names; at runtime the app's values win.

| Token | Value | Use |
| --- | --- | --- |
| `--background` | light-dark(rgb(255 255 255), rgb(24 24 24)) | page surface; keep it transparent on the conversation surface |
| `--foreground` | light-dark(rgb(26 28 31), rgb(255 255 255)) | all primary text |
| `--card` | light-dark(#ffffff, #2b2b2b) | `.card` and `.widget` fill |
| `--card-border` | var(--border) | `.card` border |
| `--card-foreground` | light-dark(rgb(26 28 31), rgb(255 255 255)) | text on `.card` |
| `--popover` | light-dark(#ffffff, rgb(45 45 45)) | tooltips, floating surfaces |
| `--popover-foreground` | light-dark(rgb(26 28 31), rgb(255 255 255)) | text on `--popover` |
| `--primary` | light-dark(#000000, #ffffff) | `.btn-primary` fill, pressed / selected controls; neutral on purpose |
| `--primary-foreground` | light-dark(#ffffff, #000000) | text on `--primary` |
| `--secondary` | light-dark(rgb(230 230 230), rgb(54 54 54)) | `.btn-secondary` fill |
| `--secondary-foreground` | light-dark(rgb(26 28 31), rgb(255 255 255)) | text on `--secondary` |
| `--muted` | foreground at 10% | quiet fills: hover, selected, table head underline base |
| `--muted-foreground` | light-dark(rgb(26 28 31 / 49.4%), rgb(255 255 255 / 49.8%)) | `.text-muted`: secondary text, captions, timestamps; never essential values |
| `--accent` | light-dark(rgb(229 242 255), rgb(13 39 63)) | soft interactive surface; `.viz-badge` fill |
| `--accent-foreground` | light-dark(rgb(51 156 255), rgb(131 195 255)) | text on `--accent` |
| `--content-accent` | light-dark(rgb(51 156 255), rgb(131 195 255)) | links, `--viz-series-1`, the one accent |
| `--destructive` | light-dark(rgb(226 85 7), rgb(255 133 73)) | `.text-destructive`: only errors the user must act on |
| `--border` | light-dark(rgb(26 28 31 / 8%), rgb(255 255 255 / 8.2%)) | dividers, `<hr>`, quiet borders |
| `--input` | light-dark(rgb(26 28 31 / 11.8%), black at 10%) | `.btn` and field borders |
| `--ring` | light-dark(rgb(51 156 255), rgb(131 195 255 / 76%)) | focus ring; never overridden |
| `--hover` | var(--muted) | hover fill |
| `--selected` | var(--muted) | selected fill |
| `--blue` | light-dark(rgb(51 156 255), rgb(51 156 255)) | status color, paired with a label |
| `--green` | light-dark(rgb(0 162 64), rgb(64 201 119)) | status color, paired with a label |
| `--orange` | light-dark(rgb(226 85 7), rgb(251 106 34)) | status color, paired with a label |
| `--red` | light-dark(rgb(224 46 42), rgb(255 103 100)) | status color, paired with a label |
| `--purple` | light-dark(rgb(146 79 247), rgb(173 123 249)) | status color, paired with a label |
| `--yellow` | light-dark(rgb(255 195 0), rgb(255 210 64)) | status color, paired with a label |

## Fonts

| Token | Value | Use |
| --- | --- | --- |
| `--font-sans` | -apple-system, system-ui, "Segoe UI", sans-serif | everything; weights 400 and 500 only |
| `--font-mono` | ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace | `<code>`: paths, commands |

Type follows the host scale and is never set by hand: body and controls `--font-size-base`
(`--font-text-md-size`, 14px); h1 body + 4px; h2 body + 2px; h3–h6 the body size; `.text-small`
body − 2px and never below 11px; heading line-height 1.25–1.3, body `calc(body * 1.5)`.

## Spacing

| Token | Value | Use |
| --- | --- | --- |
| `literal-space-2` | `2px` | inside a label/value pair |
| `literal-space-3` | `3px` | badge padding block |
| `literal-space-4` | `4px` | gap inside buttons, between icon and text, tooltip padding block |
| `literal-space-6` | `6px` | small-row padding block, `<hr>` margin block |
| `literal-space-8` | `8px` | control gaps, button and badge padding inline |
| `literal-space-10` | `10px` | grid and row gaps |
| `literal-space-12` | `12px` | `.card` padding, section gap |

The utilities `index.html` copies keep two values of the app's own that are not on this scale
(1px above and below inline `<code>`, 24px between table cells). They belong to the copied
block and stay as the app wrote them; the view's own layout block uses the table only.

## Radii

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `4px` | inline `<code>`; controls three levels deep |
| `--radius-md` | `6px` | controls two levels deep |
| `--radius-lg` | `8px` | `--control-radius` at the top level: buttons, fields, tooltips |
| `--radius-xl` | `12px` | `.card` and `.widget` |
| `--radius-full` | `9999px` | `.viz-badge`, progress tracks |

Container radii step down xl → lg → md → sm through visible card nesting; controls take the
matching parent radius (`--control-radius`) automatically. `--corner-shape: round`.

## Usage

- Utilities own geometry and states: `.btn` (28px, `.btn-primary` for the one main action,
  `.btn-ghost` for low emphasis, `.btn-sm` 24px, `.btn-xs` 20px), `.viz-badge`, `.table`,
  `.text-small`, `.text-muted`, `.text-destructive`, `.card`, `<code>`, `<hr>`,
  `[data-tooltip]`. They are used as shipped and never restyled; the view adds layout only.
- Icons: Lucide through the sandbox (`data-lucide`, 16px, `currentColor`); no inline icon SVG,
  no emoji.
- Colors are always the tokens above, as `var(--token)`; no light or dark palette is written by
  hand, `currentColor` inside SVG.
- `.text-muted` is never placed on a filled surface that would drop its contrast; errors use
  `.text-destructive` and say what to do next.
- Semantic HTML only: native `button`, `input`, `select`, `table`; tab order untouched (no
  `tabindex`), browser focus styles kept, `aria-live="polite"` for results, `role="alert"` for
  errors, `aria-hidden="true"` on decorative icons.
- Layout wraps or stacks down to 320px with no horizontal overflow; no fixed outer width.
