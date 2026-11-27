// A stand-in for ZCode around the appearance view, and the checks run against it.
//
// tests/extension/page.test.mjs puts this script into a copy of ui/index.html, after a
// `window.__appearanceRun` setting, and opens the copy in a browser. The script answers the
// page's tool calls from answers the test made by running the real extension (page-fixture.mjs),
// then uses the page the way a person would and reports everything that did not hold. Nothing
// here is shipped.
//
// window.__appearanceRun = {
//   answers: { get, set, add, remove, pick, reset, openConfig },  one answer per call in order; the last repeats
//   variables: { light, dark },                                   what the host hands over as styles.variables
//   theme, otherTheme, locale, lang, keys, start,                 the start state and what to act on
//   withoutHost, expect,                                          a page opened outside ZCode, and what it should say
// }
(function () {
  'use strict';

  const run = window.__appearanceRun;
  const calls = [];
  const served = {};
  const state = { theme: run.theme, locale: run.locale, failNext: '' };
  // What the page could not handle itself, for whoever looks at why the checks stopped.
  state.uncaught = [];
  window.__appearanceUncaught = state.uncaught;
  window.addEventListener('error', (event) => state.uncaught.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => state.uncaught.push(String(event.reason?.message ?? event.reason)));
  window.__appearanceCalls = calls;

  if (!run.withoutHost) {
    // `holdFirst` keeps the first answer back until the checks let it go, to look at the page
    // while it is waiting.
    let release = () => {};
    const gate = run.holdFirst ? new Promise((resolve) => { release = resolve; }) : null;
    state.release = release;
    // The real alias connects on first use and answers `{ structuredContent }`, or `isError`.
    const answer = async (name) => {
      if (gate) await gate;
      const queue = run.answers[name] ?? [];
      if (queue.length === 0) throw new Error(`unknown view tool: ${name}`);
      const index = Math.min(served[name] ?? 0, queue.length - 1);
      served[name] = index + 1;
      return { content: [], structuredContent: JSON.parse(JSON.stringify(queue[index])) };
    };
    Object.defineProperty(window, 'zcode', {
      value: {
        get theme() {
          return state.theme;
        },
        get locale() {
          return state.locale;
        },
        get hostContext() {
          return { theme: state.theme, locale: state.locale, styles: { variables: run.variables[state.theme] } };
        },
        callTool(name, args) {
          calls.push({ name, args: JSON.parse(JSON.stringify(args ?? {})) });
          if (state.failNext) {
            const text = state.failNext;
            state.failNext = '';
            return Promise.resolve({ isError: true, content: [{ type: 'text', text }] });
          }
          return answer(name);
        },
      },
    });
  }

  // Everything that did not hold. A check that cannot even be made (an element missing, for
  // one) ends the run, and what was found until then is still reported.
  async function checks() {
    const failures = [];
    const metrics = {};
    try {
      await runChecks(failures, metrics);
    } catch (err) {
      failures.push(`the checks stopped: ${(err && err.stack) || err}`);
    }
    return { failures, metrics };
  }

  // Any colour the engine understands (oklch, color-mix, relative) as sRGB: paint it and read
  // the pixel back.
  function colourReader() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: alpha / 255 };
    };
  }

  async function runChecks(failures, metrics) {
    const check = (name, ok, detail = '') => {
      if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
    };
    const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (read, accept, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await read();
        if (accept(value)) return value;
        if (Date.now() > deadline) return value;
        await tick(40);
      }
    };
    const $ = (id) => document.getElementById(id);
    const main = $('appearance-panel');
    const laidOut = (id) => $(id).getClientRects().length > 0;
    // How many lines the text of an element takes (its text nodes only: an icon is no line).
    const textLines = (element) => {
      const tops = new Set();
      const range = document.createRange();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
      }
      return tops.size;
    };
    const read = colourReader();
    await tick(80);

    if (run.withoutHost) {
      const said = $('appearance-error').textContent;
      check('outside ZCode the page says so', run.expect.noHost.includes(said), said);
      check('and offers to try again', !$('appearance-error-box').hidden && !$('appearance-retry').disabled);
      check('and nothing else is on screen', !['appearance-background', 'appearance-media', 'appearance-skin', 'appearance-footer'].some(laidOut));
      $('appearance-retry').click();
      await tick();
      check('trying again there says the same', $('appearance-error').textContent === said, $('appearance-error').textContent);
      return;
    }

    const first = run.answers.get[0].data;
    const text = first.text;
    const row = (file) => main.querySelector(`#appearance-media-list li[data-path="${CSS.escape(file)}"]`);
    const rows = () => main.querySelectorAll('#appearance-media-list li').length;
    const removeIn = (file) => row(file)?.querySelector('[data-action="remove"]');
    const callCount = (name) => calls.filter((call) => call.name === name).length;
    const callsOf = (name) => calls.filter((call) => call.name === name);
    const focused = () => document.activeElement;
    const click = (element) => {
      if (!element) throw new Error('the element to press is not there');
      element.click();
    };
    const change = (control, event = 'change') => control.dispatchEvent(new Event(event, { bubbles: true }));
    const visibleControls = () => [...main.querySelectorAll('button, input')].filter((control) => control.getClientRects().length > 0 && !control.closest('[hidden]'));
    const sections = ['appearance-background', 'appearance-media', 'appearance-skin', 'appearance-footer'];

    // While the answer is on its way.
    check('busy while the answer is on its way', main.getAttribute('aria-busy') === 'true');
    check('and it says so', $('appearance-status').textContent === run.expect.loading, $('appearance-status').textContent);
    check('nothing of the settings is on screen yet', !sections.some(laidOut));
    const pressable = visibleControls().filter((control) => !control.disabled);
    check('nothing can be used yet', pressable.length === 0, pressable.map((control) => control.id).join(', '));
    check('nothing was asked for but the settings', calls.length === 1 && calls[0].name === 'get', JSON.stringify(calls));
    state.release();
    await tick(80);

    // ------------------------------------------------------------------ the three stylesheets

    const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:oklch|oklab|hsl|lab|lch)\(/i;
    // What the two blocks of this view may declare, by the names they are written with.
    const LAYOUT_PROPERTIES = new Set([
      'align-items', 'border', 'border-radius', 'content', 'display', 'flex', 'flex-direction', 'flex-wrap', 'gap', 'grid-template-columns', 'height', 'justify-content', 'list-style',
      'margin', 'max-width', 'min-width', 'overflow-wrap', 'padding', 'position', 'width',
    ]);
    const DECORATION_COLOUR = new Set(['background', 'color']);
    const DECORATION_TYPE = new Set(['font-size', 'font-weight', 'line-height']);
    const SPACING = new Set([0, 2, 3, 4, 6, 8, 10, 12]);
    const styleRules = (list) => [...list].flatMap((rule) => [...(rule.style ? [rule] : []), ...(rule.cssRules ? styleRules(rule.cssRules) : [])]);
    const declarations = (style) => [...style].map((property) => ({ property, value: style.getPropertyValue(property) }));
    const contract = styleRules($('zcode-contract').sheet.cssRules);
    const layout = styleRules($('appearance-layout').sheet.cssRules);
    const decorations = styleRules($('appearance-decorations').sheet.cssRules);
    const tokens = new Set(contract.filter((rule) => rule.selectorText === ':root').flatMap((rule) => [...rule.style]));
    // The browser hands back only the names of what a shorthand with `var()` in it stands for,
    // never what was written, so the view's own two blocks are read as they were written: they
    // hold one declaration to a line, and anything else in them is reported.
    const linesOf = (id) => $(id).textContent.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.trim()).filter(Boolean);
    const DECLARATION = /^([a-z-]+):\s*(.+);$/;
    const written = (id) => linesOf(id).flatMap((line) => (DECLARATION.test(line) ? [line.match(DECLARATION)] : []));
    const otherLines = (id) => linesOf(id).filter((line) => !DECLARATION.test(line) && !/^[^{}]*\{$/.test(line) && line !== '}' && !line.startsWith('@media') && line !== ')');

    check('the contract is in the first stylesheet', contract.some((rule) => rule.selectorText === ':root' && rule.style.getPropertyValue('--background') !== ''));
    for (const rule of contract) {
      // The `:root` rule is the contract itself, and a token definition (a `--custom-property`)
      // names the fallback pair it falls back to. No utility gives a real property a colour.
      if (rule.selectorText === ':root') continue;
      for (const { property, value } of declarations(rule.style)) {
        if (property.startsWith('--')) continue;
        check('a copied rule declares no colour', !COLOUR.test(value), `${rule.selectorText} { ${property}: ${value} }`);
      }
    }
    check('the layout block is one declaration to a line', otherLines('appearance-layout').length === 0, otherLines('appearance-layout').join(' / '));
    for (const [, property, value] of written('appearance-layout')) {
      check('a layout rule of this view declares layout only', LAYOUT_PROPERTIES.has(property) && !COLOUR.test(value), `${property}: ${value}`);
    }
    check('the view has decorations', decorations.length > 0 && written('appearance-decorations').length > 0);
    check('the decoration block is one declaration to a line', otherLines('appearance-decorations').length === 0, otherLines('appearance-decorations').join(' / '));
    for (const rule of decorations) {
      check('a decoration touches only what is this view\'s own', /^\.appearance-[a-z-]+(?:\[[^\]]+\])?(?:::[a-z]+)?$/.test(rule.selectorText), rule.selectorText);
    }
    for (const [, property, value] of written('appearance-decorations')) {
      const at = `${property}: ${value}`;
      if (DECORATION_COLOUR.has(property)) {
        // `currentColor` is the colour of the text, not a colour of its own; `var(--swatch)` is
        // the skin's colour, set per swatch from the data and not the view's.
        check('a decoration takes its colour from a token', (value.includes('var(--') || value === 'currentColor') && !COLOUR.test(value), at);
        for (const [, name] of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
          if (name === '--swatch') continue;
          check('a decoration names a token the contract defines', tokens.has(name), name);
        }
      } else if (DECORATION_TYPE.has(property)) {
        check('a decoration takes its type from the contract', /^var\(--font-[a-z0-9-]+\)$/.test(value) || (property === 'line-height' && /^[\d.]+$/.test(value)), at);
      } else if (property === 'padding') {
        const steps = value.match(/[\d.]+(?=px)/g) ?? [];
        check('a decoration spaces on the host\'s scale', steps.length > 0 && steps.every((step) => SPACING.has(Number.parseFloat(step))), at);
      } else if (property === 'border-radius') {
        check('a decoration rounds with the contract', /^var\(--radius-[a-z0-9]+\)$/.test(value), at);
      } else {
        check('a decoration declares colour, type or spacing only', false, at);
      }
    }

    // Every class the page uses is a utility of the contract, or one of this view's own.
    const classesOf = (rules) => new Set(rules.flatMap((rule) => rule.selectorText?.match(/\.[a-z0-9_-]+/gi) ?? []));
    const contractClasses = classesOf(contract);
    const ownClasses = new Set([...classesOf(layout), ...classesOf(decorations)]);
    for (const name of new Set([...document.querySelectorAll('[class]')].flatMap((element) => [...element.classList]))) {
      if (name.startsWith('appearance')) check('a class of this view is declared by its own blocks', ownClasses.has(`.${name}`), name);
      else check('a class the page uses is a utility of the contract', contractClasses.has(`.${name}`), name);
    }

    // ------------------------------------------------------------------ first paint

    check('no error on screen after the first answer', $('appearance-error').textContent === '', $('appearance-error').textContent);
    check('language of the document', document.documentElement.lang === run.lang, document.documentElement.lang);
    check('title', document.title === text.title, document.title);
    check('free after the first answer', main.getAttribute('aria-busy') === 'false');
    check('the heading, and the line under it', $('appearance-title').textContent === text.title && $('appearance-subtitle').textContent === text.subtitle);
    check('it says whether the launcher runs', $('appearance-launcher').textContent === text.launcherOff, $('appearance-launcher').textContent);
    check('the three sections and the footer are on screen', sections.every(laidOut));
    check('section titles', ['appearance-background-heading', 'appearance-media-heading', 'appearance-skin-heading'].map((id) => $(id).textContent).join('|') === [text.backgroundHeading, text.mediaHeading, text.skinHeading].join('|'));
    check('the switch, named', $('appearance-enabled').checked === first.background.enabled && $('appearance-enabled-label').textContent === text.show);
    const pressed = () => [ $('appearance-scope-page'), $('appearance-scope-chat') ].filter((item) => item.getAttribute('aria-pressed') === 'true').map((item) => item.dataset.scope);
    check('the scope in use is the one pressed, and marked as the main action', JSON.stringify(pressed()) === JSON.stringify([first.background.scope]) && $('appearance-scope-page').classList.contains('btn-primary'), JSON.stringify(pressed()));
    check('the scope is named and explained', $('appearance-scope-label').textContent === text.scope && $('appearance-scope-page').textContent === text.page && $('appearance-scope-chat').textContent === text.chat && $('appearance-scope-hint').textContent === text.scopeHint);
    check('a video in the list says it needs the whole window', !$('appearance-scope-video').hidden && $('appearance-scope-video').textContent === text.videoScope);
    const mask = Math.round(first.background.mask * 100);
    check('the tint slider, its name and its value', $('appearance-mask').value === String(mask) && $('appearance-mask-value').textContent === `${mask}%` && $('appearance-mask-label').textContent === text.mask && $('appearance-mask-hint').textContent === text.maskHint);
    check('the blur slider, its name and its value', $('appearance-blur').value === String(first.background.blur) && $('appearance-blur-value').textContent === `${first.background.blur}px` && $('appearance-blur-label').textContent === text.blur && $('appearance-blur').max === String(first.limits.blurMax));
    check('blur can be used for the whole window', !$('appearance-blur').disabled);
    check('the rotation field, named, with what it means', $('appearance-rotate').value === String(first.background.rotateMinutes) && $('appearance-rotate-label').textContent === text.rotate && $('appearance-rotate-value').textContent === text.never);

    check('one row per file', rows() === first.media.length, `${rows()} of ${first.media.length}`);
    for (const [index, item] of first.media.entries()) {
      const tr = row(item.path);
      if (!tr) {
        check('a row for every file', false, item.name);
        continue;
      }
      check('in the order the extension sends them', $('appearance-media-list').children[index] === tr, item.name);
      check('named by its file, whole path in its tooltip', tr.querySelector('.appearance-media-name').textContent === item.name && tr.querySelector('.appearance-media-name').title === item.path, item.name);
      check('and by what it is', tr.textContent.includes(item.kind === 'video' ? text.video : text.picture), item.name);
      const missing = tr.querySelector('.text-destructive');
      check('a file that cannot be found says so, as an error, and only such a file does', (missing !== null) === !item.exists && (!missing || missing.textContent === text.missing), item.name);
      check('the file in use is marked, and only that one', (tr.querySelector('.appearance-current') !== null) === (index === 0), item.name);
      const remove = tr.querySelector('[data-action="remove"]');
      check('each file can be removed, and the button says what it removes', remove !== null && !remove.disabled && remove.getAttribute('aria-label') === `${text.remove} ${item.name}`, remove?.getAttribute('aria-label'));
    }
    check('the empty line is shown only when there is nothing', $('appearance-media-empty').hidden === first.media.length > 0 && $('appearance-media-empty').textContent === text.mediaEmpty);
    check('how to add a file', $('appearance-path').placeholder === text.pathPlaceholder && $('appearance-add-label').textContent === text.add && $('appearance-pick-label').textContent === text.pick && $('appearance-media-hint').textContent === text.mediaHint);
    check('the skin section is explained', $('appearance-skin-hint').textContent === text.skinHint);
    const skinButtons = [...$('appearance-skins').querySelectorAll('button')];
    check('a button per skin, and one for a skin of one\'s own', skinButtons.length === first.skins.length + 1, String(skinButtons.length));
    check('the skin in use is the one pressed', skinButtons.filter((item) => item.getAttribute('aria-pressed') === 'true').map((item) => item.dataset.skin).join(',') === (first.skin.preset === 'default' && first.skin.custom ? 'custom' : first.skin.preset));
    check('the default skin is named in the session language, the others by name', skinButtons.map((item) => item.textContent).join('|') === [...first.skins.map((skin) => (skin.name === 'default' ? text.defaultSkin : skin.name)), text.custom].join('|'), skinButtons.map((item) => item.textContent).join('|'));
    const withColours = first.skins.find((skin) => skin.light && skin.dark);
    check('a preset shows its colours, light over dark, and the default shows none', withColours && $('appearance-skins').querySelector(`[data-skin="${withColours.name}"]`).querySelectorAll('.appearance-swatch').length === 10 && $('appearance-skins').querySelector('[data-skin="default"]').querySelectorAll('.appearance-swatch').length === 0);
    check('the swatches are not read out: the name is the button', $('appearance-skins').querySelector('.appearance-swatches').getAttribute('aria-hidden') === 'true');
    check('the colours of one\'s own are shown only when that skin is in use', $('appearance-colours').hidden === !(first.skin.preset === 'default' && first.skin.custom));
    check('two ways out at the bottom', $('appearance-open-config-label').textContent === text.openConfig && $('appearance-reset-label').textContent === text.reset && $('appearance-reset-confirm').hidden);
    check('the config file is named for whoever looks for it', typeof first.file === 'string' && first.file.length > 0);

    for (const control of visibleControls()) {
      if (control.tagName === 'BUTTON') check('a button has a name', control.textContent.trim() !== '' || (control.getAttribute('aria-label') ?? '').trim() !== '', control.id);
      else check('a field has exactly one label', control.labels?.length === 1 && control.labels[0].textContent.trim() !== '', control.id);
    }
    // Nothing on a row wraps onto a second line at the width of the side pane: the kind, the
    // mark and the button each keep their line.
    for (const item of main.querySelectorAll('.appearance-current, .appearance-actions button')) check('a mark or a button on a row keeps to one line', textLines(item) <= 1);

    // ------------------------------------------------------------------ icons and decorations

    const iconSize = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--icon-size'));
    const icons = [...main.querySelectorAll('svg.appearance-icon')];
    // The title, "Add", "Choose files…", "Open the settings file", "Restore defaults", and per
    // file its kind and its remove button.
    check('every icon is drawn from a symbol', icons.length === 5 + first.media.length * 2 && icons.every((icon) => icon.querySelector('use') && icon.getAttribute('aria-hidden') === 'true'), String(icons.length));
    for (const icon of icons) {
      const box = icon.getBoundingClientRect();
      // The box of an `<svg>` is the same whether its symbol exists or not; the drawing has a size of its own.
      const drawn = icon.getBBox();
      check('an icon has a drawing in it', drawn.width > 0 && drawn.height > 0, `${drawn.width} x ${drawn.height}`);
      check('an icon is the size the contract names', Math.abs(box.width - iconSize) < 0.5 && Math.abs(box.height - iconSize) < 0.5, `${box.width} x ${box.height}`);
      check('and takes the colour of the text it sits with', getComputedStyle(icon).stroke === getComputedStyle(icon).color && getComputedStyle(icon).color === getComputedStyle(icon.parentElement).color);
    }
    for (const id of ['appearance-background-heading', 'appearance-media-heading', 'appearance-skin-heading']) {
      const before = getComputedStyle($(id), '::before');
      check('a section title has its bar', parseFloat(before.width) > 0 && parseFloat(before.height) > 0 && read(before.backgroundColor).a > 0, `${id}: ${before.width} x ${before.height}`);
    }
    const tiles = [...main.querySelectorAll('.appearance-icon-tile')];
    check('the title icon sits on a tinted tile', tiles.length === 1 && read(getComputedStyle(tiles[0]).backgroundColor).a > 0);
    const swatch = $('appearance-skins').querySelector('.appearance-swatch');
    check('a swatch shows its skin\'s colour, not a token', read(getComputedStyle(swatch).backgroundColor).a === 1 && !['rgba(0, 0, 0, 0)'].includes(getComputedStyle(swatch).backgroundColor), getComputedStyle(swatch).backgroundColor);

    // ------------------------------------------------------------------ fitting, contrast

    const luminance = ({ r, g, b }) => [r, g, b]
      .map((value) => {
        const s = value / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const over = (top, base) => ({
      r: top.r * top.a + base.r * (1 - top.a),
      g: top.g * top.a + base.g * (1 - top.a),
      b: top.b * top.a + base.b * (1 - top.a),
    });
    const backgroundOf = (element) => {
      const layers = [];
      for (let node = element; node && layers.length < 50; node = node.parentElement) {
        const colour = read(getComputedStyle(node).backgroundColor);
        if (colour.a > 0) {
          layers.push(colour);
          if (colour.a === 1) break;
        }
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
    };
    const fits = () => {
      const root = document.documentElement;
      check('the page does not scroll sideways', root.scrollWidth <= root.clientWidth, `${root.scrollWidth} > ${root.clientWidth}`);
      const wide = [...main.querySelectorAll('*')].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > window.innerWidth + 0.5 || box.left < -0.5);
      });
      check('nothing sticks out of the window', wide.length === 0, wide.map((element) => `${element.tagName}.${element.className}`).join(', '));
    };
    const reportContrast = (label) => {
      const lowest = {};
      for (const element of main.querySelectorAll('*')) {
        if (!element.getClientRects().length || element.closest(':disabled') || element.closest('[hidden]')) continue;
        if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')) continue;
        const background = backgroundOf(element);
        const colour = read(getComputedStyle(element).color);
        const value = ratio(colour.a < 1 ? over(colour, background) : colour, background);
        const kind = `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/).join('.')}` : ''}`;
        lowest[kind] = Math.min(lowest[kind] ?? Infinity, value);
        check(`text meets WCAG AA in ${label}`, value >= 4.5, `${kind} "${element.textContent.trim().slice(0, 16)}" ${value}:1`);
      }
      metrics[`${label}Contrast`] = Object.fromEntries(Object.entries(lowest).sort((a, b) => a[1] - b[1]));
      // Icons and bars are shapes: they need 3:1 against what they sit on. Asked for again here:
      // the rows were redrawn since the first paint, and an icon that left the page has no colour.
      for (const icon of main.querySelectorAll('svg.appearance-icon')) {
        if (!icon.getClientRects().length || icon.closest('[hidden]')) continue;
        const value = ratio(read(getComputedStyle(icon).color), backgroundOf(icon));
        check(`an icon stands out from its background in ${label}`, value >= 3, `${value}:1 ${icon.parentElement.className}`);
        metrics[`${label}IconContrast`] = Math.min(metrics[`${label}IconContrast`] ?? Infinity, value);
      }
    };
    metrics.viewport = window.innerWidth;
    fits();
    reportContrast(run.theme);

    // ------------------------------------------------------------------ the sliders and the rotation

    const setsBefore = callCount('set');
    $('appearance-mask').value = '50';
    change($('appearance-mask'), 'input');
    check('the value next to the slider follows the thumb at once', $('appearance-mask-value').textContent === '50%');
    change($('appearance-mask'));
    await tick(200);
    check('one drag of the tint slider sends the tint once, as a share', callCount('set') === setsBefore + 1 && JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ mask: 0.5 }), JSON.stringify(callsOf('set').slice(setsBefore)));
    check('and nothing is said about it', $('appearance-status').textContent === '', $('appearance-status').textContent);
    $('appearance-blur').value = '4';
    change($('appearance-blur'), 'input');
    change($('appearance-blur'));
    await tick(200);
    check('moving the blur slider sends the blur in pixels', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ blur: 4 }) && $('appearance-blur-value').textContent === '4px', JSON.stringify(callsOf('set').at(-1)));
    const before = callCount('set');
    $('appearance-rotate').value = '-1';
    change($('appearance-rotate'));
    await tick();
    check('a negative interval is stopped by its field and put back', callCount('set') === before && $('appearance-rotate').value === '0' && $('appearance-status').classList.contains('text-destructive'));
    $('appearance-rotate').value = '30';
    change($('appearance-rotate'));
    await tick();
    check('an interval is sent in minutes, and said in words', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ rotateMinutes: 30 }) && $('appearance-rotate-value').textContent === text.every.replace('{n}', 30), $('appearance-rotate-value').textContent);

    // ------------------------------------------------------------------ adding and removing files

    const { first: firstFile, gone, clip, late, picked } = run.keys;
    $('appearance-path').value = late;
    $('appearance-add-form').requestSubmit();
    await tick();
    check('a typed path is added as it was typed', JSON.stringify(callsOf('add').at(-1)?.args) === JSON.stringify({ paths: [late] }));
    check('the field is emptied, the file is listed, and it is said', $('appearance-path').value === '' && row(late) !== null && rows() === first.media.length + 1 && $('appearance-status').textContent === run.answers.add[0].message, $('appearance-status').textContent);
    click($('appearance-pick'));
    await tick();
    check('the file dialog is asked for, and for nothing else', JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'pick', args: {} }) && $('appearance-status').textContent === run.answers.pick[0].message, $('appearance-status').textContent);
    check('and nothing changes while it is open', rows() === first.media.length + 1);
    await until(() => row(picked) !== null, Boolean);
    check('what the dialog gave is listed when it closes', row(picked) !== null && rows() === first.media.length + 2);
    check('and said in the words of the extension', $('appearance-status').textContent === run.answers.get[1].data.pick.message, $('appearance-status').textContent);
    const reads = callCount('get');
    await tick(500);
    check('the page stops asking once the dialog is done', callCount('get') === reads, `${callCount('get') - reads} more reads`);

    const goneButton = removeIn(gone);
    check('focus is on the button that is about to go', (goneButton.focus(), focused() === goneButton));
    click(goneButton);
    await tick();
    check('removing sends that file\'s path, and only that', JSON.stringify(callsOf('remove').at(-1)?.args) === JSON.stringify({ path: gone }));
    check('the row is gone and the others stay', row(gone) === null && rows() === first.media.length + 1);
    check('focus moves on to the next file, not off the page', focused()?.closest('li')?.dataset.path === clip, focused()?.outerHTML.slice(0, 80));
    check('it is said', $('appearance-status').textContent === run.answers.remove[0].message);

    // ------------------------------------------------------------------ the switch and the scope

    click($('appearance-enabled'));
    await tick();
    check('the switch sends true or false', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ enabled: false }) && !$('appearance-enabled').checked);
    click($('appearance-scope-chat'));
    await tick();
    check('the scope is sent', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ scope: 'chat' }));
    check('the other scope is pressed now', $('appearance-scope-chat').classList.contains('btn-primary') && $('appearance-scope-chat').getAttribute('aria-pressed') === 'true' && $('appearance-scope-page').getAttribute('aria-pressed') === 'false');
    check('blur cannot be used for the conversation area', $('appearance-blur').disabled);

    // ------------------------------------------------------------------ skins

    click($('appearance-skins').querySelector('[data-skin="midnight"]'));
    await tick();
    check('a preset is sent by name', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ skin: 'midnight' }));
    check('and is the one pressed', $('appearance-skins').querySelector('[data-skin="midnight"]').getAttribute('aria-pressed') === 'true');
    check('with no colours of one\'s own to edit', $('appearance-colours').hidden);
    click($('appearance-skins').querySelector('[data-skin="custom"]'));
    await tick();
    check('a skin of one\'s own starts from the colours already there', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ skin: 'default', customSkin: run.start }));
    check('the colours are shown, ten of them, in two sets', !$('appearance-colours').hidden && $('appearance-colours').querySelectorAll('input[type="color"]').length === 10 && $('appearance-light-legend').textContent === text.light && $('appearance-dark-legend').textContent === text.dark);
    check('each named', [...$('appearance-colours').querySelectorAll('label')].map((label) => label.textContent.trim()).join('|') === [text.base, text.surface, text.text, text.accent, text.border, text.base, text.surface, text.text, text.accent, text.border].join('|'));
    check('a skin of one\'s own is the one pressed', $('appearance-skins').querySelector('[data-skin="custom"]').classList.contains('btn-primary'));
    const accent = $('appearance-colours').querySelector('input[data-mode="light"][data-key="accent"]');
    accent.focus();
    accent.value = '#ff0000';
    change(accent, 'input');
    await tick(200);
    check('a colour is sent with the whole skin it belongs to', JSON.stringify(callsOf('set').at(-1)?.args) === JSON.stringify({ skin: 'default', customSkin: { ...run.start, light: { ...run.start.light, accent: '#ff0000' } } }), JSON.stringify(callsOf('set').at(-1)?.args));
    check('and the colour control is still the one being used', focused() === accent, focused()?.outerHTML.slice(0, 60));

    // ------------------------------------------------------------------ a call that fails, and the way back

    click($('appearance-open-config'));
    await tick();
    check('opening the settings file asks the extension, and for nothing else', JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'openConfig', args: {} }) && $('appearance-status').textContent === text.opened && $('appearance-error').textContent === '', `${JSON.stringify(calls.at(-1))} | ${$('appearance-status').textContent} | ${$('appearance-error').textContent}`);
    check('and the settings stay on screen after it', !$('appearance-background').hidden && $('appearance-scope-chat').classList.contains('btn-primary'));
    state.failNext = 'Extension view was closed';
    click($('appearance-scope-page'));
    await tick();
    check('a failed call is said as an error', $('appearance-error').textContent === `${run.expect.failed}Extension view was closed`, $('appearance-error').textContent);
    check('with a way back', !$('appearance-error-box').hidden && !$('appearance-retry').disabled);
    check('and the settings before it stay on screen', $('appearance-scope-chat').classList.contains('btn-primary'));
    click($('appearance-retry'));
    await tick();
    check('trying again recovers', $('appearance-error').textContent === '' && $('appearance-error-box').hidden && !$('appearance-enabled').disabled);

    // ------------------------------------------------------------------ restoring the defaults asks first

    const files = rows();
    click($('appearance-reset'));
    await tick();
    check('the first press asks', !$('appearance-reset-confirm').hidden && $('appearance-reset').hidden && callCount('reset') === 0);
    check('and says what restoring means', $('appearance-reset-question').textContent === text.resetConfirm);
    check('focus goes to the question', focused()?.id === 'appearance-reset-yes', focused()?.outerHTML.slice(0, 60));
    main.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    check('Escape withdraws the question', !$('appearance-reset').hidden && $('appearance-reset-confirm').hidden && callCount('reset') === 0);
    check('focus returns to the button', focused()?.id === 'appearance-reset');
    click($('appearance-reset'));
    await tick();
    click($('appearance-reset-yes'));
    await tick();
    check('the second press restores, once', callCount('reset') === 1 && JSON.stringify(callsOf('reset')[0].args) === JSON.stringify({}));
    check('and says so', $('appearance-status').textContent === text.resetDone);
    const after = run.answers.reset[0].data;
    check('the defaults are on screen', $('appearance-mask').value === String(Math.round(after.background.mask * 100)) && $('appearance-enabled').checked && $('appearance-scope-page').classList.contains('btn-primary') && !$('appearance-blur').disabled);
    check('the files stay', rows() === files);
    check('focus stays inside the view', main.contains(focused()));

    // ------------------------------------------------------------------ the other theme

    state.theme = run.otherTheme;
    window.dispatchEvent(new Event('zcode:globals'));
    await tick();
    check('a theme switch is followed', document.documentElement.getAttribute('data-theme') === run.otherTheme);
    const probe = document.createElement('i');
    probe.style.color = run.variables[run.otherTheme]['--color-text-primary'];
    document.body.append(probe);
    check('and so is the text colour', getComputedStyle($('appearance-title')).color === getComputedStyle(probe).color, getComputedStyle($('appearance-title')).color);
    probe.remove();
    fits();
    reportContrast(run.otherTheme);
  }

  window.__appearanceChecks = checks;
})();
