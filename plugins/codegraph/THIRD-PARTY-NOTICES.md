# Third-Party Notices

This plugin bundles prebuilt tree-sitter WebAssembly grammars and the
web-tree-sitter runtime. The plugin itself adds no license terms to them.
Each component keeps its own license; the full texts are in
`grammars/LICENSES/` and `grammars/runtime/LICENSE.web-tree-sitter.txt`.

Machine-readable provenance (sha256, source, version, license) for every
wasm is in `grammars/manifest.json`.

## 1. web-tree-sitter 0.25.10

- Files: `grammars/runtime/web-tree-sitter.mjs` (the package's `tree-sitter.js`
  ESM build, renamed only), `grammars/runtime/tree-sitter.wasm`
- Source: npm `web-tree-sitter@0.25.10`, https://github.com/tree-sitter/tree-sitter (`lib/binding_web`)
- License: MIT, Copyright (c) 2018-2024 Max Brunsfeld
- Full text: `grammars/runtime/LICENSE.web-tree-sitter.txt`

## 2. tree-sitter-wasms 0.1.13 (packaging only)

- Source: npm `tree-sitter-wasms@0.1.13`, https://github.com/Gregoor/tree-sitter-wasms
- License: Unlicense (public domain). The package only compiles and republishes
  the upstream grammars; the grammars keep their own licenses (section 3).
- Full text: see below.

```
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
```

## 3. Grammars

Source column: **A** = taken from npm `tree-sitter-wasms@0.1.13`
(`out/tree-sitter-<grammar>.wasm`, built from the upstream grammar at the
version declared in that package); **B** = taken from the local clone of
https://github.com/colbymchenry/codegraph (`src/extraction/wasm/`, commit
`461a5d8`), which builds them from the upstream repositories listed below.
Each row's full license text is `grammars/LICENSES/<grammar>.txt`.

| Grammar | Upstream | License | Copyright | Source |
|---|---|---|---|---|
| typescript, tsx | https://github.com/tree-sitter/tree-sitter-typescript | MIT | (c) 2017 Max Brunsfeld | A |
| javascript | https://github.com/tree-sitter/tree-sitter-javascript | MIT | (c) 2014 Max Brunsfeld | A |
| python | https://github.com/tree-sitter/tree-sitter-python | MIT | (c) 2016 Max Brunsfeld | A |
| go | https://github.com/tree-sitter/tree-sitter-go | MIT | (c) 2014 Max Brunsfeld | A |
| rust | https://github.com/tree-sitter/tree-sitter-rust | MIT | (c) 2017 Maxim Sokolov | A |
| java | https://github.com/tree-sitter/tree-sitter-java | MIT | (c) 2017 Ayman Nadeem | A |
| c_sharp | https://github.com/tree-sitter/tree-sitter-c-sharp | MIT | (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors | A |
| php | https://github.com/tree-sitter/tree-sitter-php | MIT | (c) 2017 Josh Vera, GitHub | A |
| ruby | https://github.com/tree-sitter/tree-sitter-ruby | MIT | (c) 2016 Rob Rix | A |
| c | https://github.com/tree-sitter/tree-sitter-c | MIT | (c) 2014 Max Brunsfeld | A |
| cpp | https://github.com/tree-sitter/tree-sitter-cpp | MIT | (c) 2014 Max Brunsfeld | A |
| objc | https://github.com/tree-sitter-grammars/tree-sitter-objc | MIT | (c) 2023 Amaan Qureshi | A |
| swift | https://github.com/alex-pinkus/tree-sitter-swift (+ codegraph patch) | MIT | (c) 2021 alex-pinkus | B (build copied from codegraph; the tree-sitter-wasms build crashed V8 tier-up, see section 4) |
| kotlin | https://github.com/fwcd/tree-sitter-kotlin | MIT | (c) 2019 fwcd | A |
| scala | https://github.com/tree-sitter/tree-sitter-scala | MIT | (c) 2018 Max Brunsfeld and GitHub | A |
| dart | https://github.com/UserNobody14/tree-sitter-dart | MIT | (c) 2020-2022 UserNobody14 and others (npm metadata says ISC; the LICENSE file text is MIT) | A |
| vue | https://github.com/tree-sitter-grammars/tree-sitter-vue | MIT | (c) 2024 Amaan Qureshi | A |
| lua | https://github.com/Azganoth/tree-sitter-lua | MIT | (c) 2022 Ademir José Ferreira Júnior | B (build copied from codegraph; the tree-sitter-wasms build was replaced, see section 4) |
| solidity | https://github.com/JoranHonig/tree-sitter-solidity | MIT | (c) 2020 Joran Honig | A |
| embedded_template | https://github.com/tree-sitter/tree-sitter-embedded-template | MIT | (c) 2018 Max Brunsfeld | A |
| arkts | https://github.com/harmony-contrib/tree-sitter-arkts | MIT | (c) 2026-present richerfu | B |
| luau | https://github.com/tree-sitter-grammars/tree-sitter-luau | MIT | (c) 2023 Amaan Qureshi | B (byte-identical to npm `tree-sitter-luau@1.2.0`) |
| r | https://github.com/r-lib/tree-sitter-r | MIT | (c) 2025 tree-sitter-r authors | B |
| terraform | https://github.com/tree-sitter-grammars/tree-sitter-hcl (`dialects/terraform`) | Apache-2.0 | Apache License 2.0 | B |
| nix | https://github.com/nix-community/tree-sitter-nix | MIT | (c) 2019 Charles Strahan | B |
| pascal | https://github.com/Isopod/tree-sitter-pascal | MIT | (c) 2018 Benjamin Gray | B |
| vbnet | https://github.com/govindbanura/tree-sitter-vbnet (commit `538b7087` + codegraph patch) | MIT | (c) 2025 Govind Banura (npm metadata says ISC; the LICENSE file text is MIT) | B |
| erlang | https://github.com/WhatsApp/tree-sitter-erlang | Apache-2.0 | Apache License 2.0 | B |
| cfml, cfscript, cfquery | https://github.com/cfmleditor/tree-sitter-cfml | MIT | (c) 2014 Gareth Edwards & Gavin Baumanis | B |

### MIT (text used by the MIT-licensed grammars above)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache-2.0 (terraform, erlang)

Full text: `grammars/LICENSES/terraform.txt` and `grammars/LICENSES/erlang.txt`
(Apache License, Version 2.0, http://www.apache.org/licenses/).

## 4. colbymchenry/codegraph

The 13 wasm files marked B (11 grammars from the B list plus `lua` and `swift`) were copied
from the repository https://github.com/colbymchenry/codegraph (commit `461a5d8`,
`src/extraction/wasm/`). That repository is MIT-licensed; the wasm files are
builds of the upstream grammars listed in section 3 and carry those licenses.
The `vbnet` and `swift` builds additionally include grammar patches published in
that repository (`docs/grammars/tree-sitter-vbnet.patch`,
`docs/grammars/tree-sitter-swift.patch`). `lua` was switched from the
`tree-sitter-wasms@0.1.13` build to this one because the former misparsed valid
Lua once other grammars had been loaded in the same process. `swift` was switched
because the `tree-sitter-wasms` build is the only grammar whose V8 TurboFan
tier-up aborts the whole Node process on Node 24.21.

Not bundled: `cobol`. The codegraph build of `tree-sitter-cobol` (16 MB) makes
V8 abort the whole Node process ("Fatal process out of memory: Zone") at isolate
disposal after the first parse unless Node is started with `--liftoff-only`;
ZCode starts the MCP server without that flag, so COBOL files are indexed at
file level only.

```
MIT License

Copyright (c) 2026 Colby Mchenry

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 5. Reference queries

`grammars/queries/<grammar>/` holds unmodified `tags.scm` / `locals.scm` files
from the same upstream grammar packages (versions recorded per grammar in
`grammars/manifest.json`, field `queriesSource`). They carry the license of the
grammar they belong to.

## 6. Not bundled

Liquid: no tree-sitter grammar was found for it; the plugin treats it as
`file-level` (no symbol extraction) and ships nothing for it.

## 7. ZCode sandbox stylesheet (rules reproduced in `ui/index.html`)

The first `<style>` block of `ui/index.html` (`id="zcode-contract"`) is a
rule-for-rule copy of the stylesheet ZCode Desktop ships for UI rendered inside
the app (ZCode Desktop 4.0.10870, `out/plugin-sandbox/visualize.css`), minus the
rules this view does not use. It is there so that the plugin's index management
view looks the way every other sandboxed view in ZCode looks; the rules are
reproduced as the app wrote them and are not edited. ZCode's own terms apply to
that block. The second `<style>` block (`id="codegraph-layout"`) is this
plugin's own and contains layout only.
