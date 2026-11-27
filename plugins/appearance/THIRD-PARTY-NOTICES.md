# Third-party notices — appearance

The plugin's own code has no third-party dependencies and runs without `npm install`. Two
things are carried along as they are:

## 1. ZCode sandbox stylesheet (the `#zcode-contract` block of `ui/index.html`)

- Files: the first `<style>` block of `ui/index.html`.
- Source: ZCode Desktop, `out/plugin-sandbox/visualize.css` (the stylesheet the app ships for
  its sandboxed views). The same file is in the public repository
  <https://github.com/zai-org/ZCode> at
  `apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/visualize.css`.
- License: Apache-2.0. Copyright 2026 Z.AI Co., Ltd. The full text is in
  `ui/licenses/LICENSE.zcode.txt`.
- What was taken: the rules this view uses, copied rule for rule and not edited. It is the
  same subset the `codegraph` view of this repository keeps, which was compared rule for rule
  with the app's file (`.tmp/zcode-ui/verbatim.mjs`, 2026-11-25); the only difference here is
  the sentence of the block's header that points at this notice. The tokens the block names are
  listed in `ui/design-system-zcode.md`.

## 2. Lucide icons (inlined in `ui/index.html`)

- Files: `ui/icons/*.svg` — `palette`, `image`, `film`, `plus`, `undo-2`, `folder-open`,
  `trash-2`.
- Source: npm `lucide-static@0.468.0`, <https://lucide.dev>,
  <https://github.com/lucide-icons/lucide> (`packages/lucide-static/icons/`).
- License: ISC. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
  of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
  The full text is in `ui/icons/LICENSE.lucide.txt`.
- What was taken: the drawing of each file, inlined as a `<symbol>` without the `class`,
  `width` and `height` attributes (the view sizes icons with the contract's `--icon-size`).
  `tests/extension/icons.test.mjs` holds the symbols and the files together.
