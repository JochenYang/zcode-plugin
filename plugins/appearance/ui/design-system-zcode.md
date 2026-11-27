---
name: zcode
sources:
  - ZCode Desktop, out/plugin-sandbox/visualize.css (the "agent-facing contract" the bundled visualize skill is kept in sync with)
---

# zcode

ZCode's own theme contract for UI rendered inside the app, taken verbatim from the stylesheet the
app ships for its sandboxed views. Every color is a theme variable that resolves from the running
app (`--color-*`) and falls back to the light / dark pair listed here; a view never hardcodes a
palette. The token tables are the ones `plugins/codegraph/ui/design-system-zcode.md` records for
the same contract (checked with the design skill's `design-lint.mjs` there).

## Colors

Light / dark are the fallback pair the contract names; at runtime the app's values win.

| Token | Value | Use |
| --- | --- | --- |
| `--background` | light-dark(rgb(255 255 255), rgb(24 24 24)) | page surface; left transparent |
| `--foreground` | light-dark(rgb(26 28 31), rgb(255 255 255)) | all primary text |
| `--card` | light-dark(#ffffff, #2b2b2b) | `.card` fill: the three sections |
| `--card-border` | var(--border) | `.card` border |
| `--primary` | light-dark(#000000, #ffffff) | `.btn-primary`: the scope and the skin in use, the one confirming press |
| `--primary-foreground` | light-dark(#ffffff, #000000) | text on `--primary` |
| `--secondary` | light-dark(rgb(230 230 230), rgb(54 54 54)) | `.btn-secondary`: "Add" |
| `--muted-foreground` | light-dark(rgb(26 28 31 / 49.4%), rgb(255 255 255 / 49.8%)) | `.text-muted`: never used for this view's own text, see below |
| `--content-accent` | light-dark(rgb(51 156 255), rgb(131 195 255)) | the title icon's tile, the bar before a section title |
| `--destructive` | light-dark(rgb(226 85 7), rgb(255 133 73)) | `.text-destructive`: errors, and a background file that cannot be found |
| `--muted` | foreground at 10% | the pill that marks the background in use |
| `--border`, `--input`, `--ring` | — | card border, control borders, focus ring (never overridden) |

## Fonts, spacing, radii

Type follows the host scale and is never set by hand (`--font-sans`, body and controls
`--font-size-base`, headings from the contract's `h1` / `h2`, `.text-small` for captions,
`.tabular-nums` for the values next to the sliders). Spacing is the contract's scale only
(2, 3, 4, 6, 8, 10, 12 px); radii are `--radius-sm` for swatches, `--radius-md` for the icon
tile, `--radius-full` for the pill and the bar.

## Usage

- Utilities own geometry and states: `.card`, `.btn` with `.btn-primary` / `.btn-secondary` /
  `.btn-ghost` and `.btn-sm` / `.btn-xs`, `.form-label`, `.form-control.form-control-sm`,
  `.form-range`, `.viz-controls` (a label and its control on the host's grid), `.text-small`,
  `.text-destructive`, `.tabular-nums`, `.sr-only`. They are used as shipped and never
  restyled. The view adds layout (`#appearance-layout`) and the few decorations listed under
  "What this view adds" (`#appearance-decorations`), nothing else.
- The sliders and the check box are the browser's own controls: the contract gives `.form-range`
  no track or thumb of its own, so none is drawn here.
- Icons are Lucide, at the contract's `--icon-size` in `currentColor`, inlined as `<symbol>`
  elements from the official files (ISC, `ui/icons/`) and used with `<use>`. No emoji, no icon
  of the view's own drawing.
- Semantic HTML only: native `button`, `input`, `label`, `fieldset`, `form`; tab order
  untouched, browser focus styles kept, `aria-live="polite"` for the status line,
  `role="alert"` for errors, `aria-pressed` on the scope and skin buttons, `aria-hidden="true"`
  on decorative icons and on the swatches (the skin's name is the button's text).
- Layout wraps or stacks down to 320px with no horizontal overflow; no fixed outer width.

## What this view adds

| Decoration | Tokens | Used for |
| --- | --- | --- |
| Tinted tile behind an icon | `--content-accent` (icon mixed 50 / 50 with `--foreground`; background the same colour at 12% in `transparent`) | the title icon |
| Bar before a section title | `--content-accent` | "Background", "Pictures and videos", "Colour skin" |
| Quiet colour for captions | `--muted-foreground` mixed 80 / 20 with `--foreground`; line-height 1.5, the body's measure | the subtitle, hints, a file's kind, the launcher line |
| Pill in the muted fill | `--muted` background, `--foreground` text, `--font-size-small` medium | "Current" on the first background file |
| Swatch | the skin's own colour, as `--swatch` set from the data the extension sent | the five colours of a preset, two rows for light and dark |

The contract's `.text-muted` is 4.26:1 on the page in the app's light theme, short of WCAG AA,
so the view does not use it for its own text: `.appearance-caption` takes the same color with a
fifth of the foreground mixed in (4.99:1 there, lighter and still above 5:1 in the dark theme),
the share the `codegraph` view measured with ZCode 4.0.10870. The tile's icon colour is that
view's measured share as well (3.99:1 there as a shape, above 3:1).

The captions take the body's line-height (1.5) rather than `.text-small`'s 1.33: that measure is
set for Latin lines, and a two-line Chinese hint at it reads cramped (the design skill's audit
flags it at 390px).

What sits directly on the page (not inside a card) is the title row only; the page's own gutter
is the host's 12px, so text or a control placed there would stand closer to the window edge than
everything in the cards (24px with a card's padding). The status line and the error with its way
back are cards that take no room while empty; the footer with its two buttons is a card too.

A swatch is the one place a colour that is not a token appears on screen, and it is not the
view's: it shows the skin the user is choosing between. The rule reads `var(--swatch)`; the
value is set per swatch from the data, so the stylesheet itself names no colour.
