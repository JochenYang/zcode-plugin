// A stand-in for ZCode around the storage view, and the checks run against it.
//
// tests/extension/page.test.mjs puts this script into a copy of ui/index.html, after a
// `window.__codegraphRun` setting, and opens the copy in a browser. The script answers the
// page's tool calls from data the test made with the real `viewData`, then uses the page the
// way a person would and reports everything that did not hold. Nothing here is shipped.
//
// window.__codegraphRun = {
//   answers: { list, remove, clean, policy, open },  one answer per call in order; the last repeats
//   variables: { light, dark },                      what the host hands over as styles.variables
//   theme, otherTheme, locale, lang, keys,           the start state and the rows to act on
//   withoutHost, expect,                             a page opened outside ZCode, and what it should say
// }
(function () {
  'use strict';

  const run = window.__codegraphRun;
  const calls = [];
  const served = {};
  const state = { theme: run.theme, locale: run.locale, failNext: '' };

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
    // The clipboard, as the checks set it: refused, as in a sandbox without the permission,
    // until they allow it.
    const written = [];
    let allowed = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => ({
        writeText: async (value) => {
          // What a browser says when a page without the user's press asks for the clipboard.
          if (!allowed) throw new DOMException('Document is not focused.', 'NotAllowedError');
          written.push(value);
        },
      }),
    });
    window.__codegraphClipboard = { allow: () => { allowed = true; }, written };
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
    const $ = (id) => document.getElementById(id);
    const main = $('codegraph-storage');
    const laidOut = (id) => $(id).getClientRects().length > 0;
    // How many lines the text of an element takes (its text nodes only: a dot or an icon is no line).
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
      const said = $('storage-error').textContent;
      check('outside ZCode the page says so', run.expect.noHost.includes(said), said);
      check('and offers to try again', !$('storage-retry').hidden && !$('storage-retry').disabled);
      check('and nothing else is on screen', !['storage-stats', 'storage-store', 'storage-indexes', 'policy-form'].some(laidOut));
      $('storage-retry').click();
      await tick();
      check('trying again there says the same', $('storage-error').textContent === said, $('storage-error').textContent);
      return;
    }

    const { keys } = run;
    const first = run.answers.list[0].data;
    const text = first.text;
    const row = (key) => main.querySelector(`tr[data-key="${key}"]`);
    const inRow = (key, action) => row(key)?.querySelector(`button[data-action="${action}"]`);
    const rows = () => main.querySelectorAll('#storage-rows tr').length;
    const callCount = (name) => calls.filter((call) => call.name === name).length;
    const focused = () => document.activeElement;
    const click = (element) => {
      if (!element) throw new Error('the element to press is not there');
      element.click();
    };
    const visibleControls = () => [...main.querySelectorAll('button, input')].filter((control) => control.getClientRects().length > 0 && !control.closest('[hidden]'));

    // While the answer is on its way.
    check('busy while the answer is on its way', main.getAttribute('aria-busy') === 'true');
    check('and it says so', $('storage-status').textContent === run.expect.loading, $('storage-status').textContent);
    check('nothing of the store is on screen yet', !['storage-stats', 'storage-store', 'storage-indexes', 'policy-form'].some(laidOut));
    const pressable = visibleControls().filter((control) => !control.disabled);
    check('nothing can be used yet', pressable.length === 0, pressable.map((control) => control.id).join(', '));
    check('nothing was asked for but the list', calls.length === 1 && calls[0].name === 'list', JSON.stringify(calls));
    state.release();
    await tick(80);

    // ------------------------------------------------------------------ the three stylesheets

    const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:oklch|oklab|hsl|lab|lch)\(/i;
    // What the two blocks of this view may declare, by the names they are written with.
    const LAYOUT_PROPERTIES = new Set([
      'align-items', 'content', 'display', 'flex', 'flex-direction', 'flex-wrap', 'gap', 'grid-template-columns', 'height', 'justify-content', 'list-style',
      'margin', 'margin-block-start', 'max-width', 'min-width', 'overflow', 'overflow-wrap', 'padding', 'position', 'white-space', 'width',
      'word-break', 'border-radius', '-webkit-box-orient', '-webkit-line-clamp',
    ]);
    const DECORATION_COLOUR = new Set(['background', 'color']);
    const DECORATION_TYPE = new Set(['font-family', 'font-size', 'font-weight', 'line-height']);
    const SPACING = new Set([0, 2, 3, 4, 6, 8, 10, 12]);
    const styleRules = (list) => [...list].flatMap((rule) => [...(rule.style ? [rule] : []), ...(rule.cssRules ? styleRules(rule.cssRules) : [])]);
    const declarations = (style) => [...style].map((property) => ({ property, value: style.getPropertyValue(property) }));
    const contract = styleRules($('zcode-contract').sheet.cssRules);
    const layout = styleRules($('codegraph-layout').sheet.cssRules);
    const decorations = styleRules($('codegraph-decorations').sheet.cssRules);
    const tokens = new Set(contract.filter((rule) => rule.selectorText === ':root').flatMap((rule) => [...rule.style]));
    // The browser hands back only the names of what a shorthand with `var()` in it stands for,
    // never what was written, so the view's own two blocks are read as they were written: they
    // hold one declaration to a line, and anything else in them is reported.
    const linesOf = (id) => $(id).textContent.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.trim()).filter(Boolean);
    const DECLARATION = /^([a-z-]+):\s*(.+);$/;
    const written = (id) => linesOf(id).flatMap((line) => (DECLARATION.test(line) ? [line.match(DECLARATION)] : []));
    const otherLines = (id) => linesOf(id).filter((line) => !DECLARATION.test(line) && !/^[^{}]*\{$/.test(line) && line !== '}');

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
    check('the layout block is one declaration to a line', otherLines('codegraph-layout').length === 0, otherLines('codegraph-layout').join(' / '));
    for (const [, property, value] of written('codegraph-layout')) {
      check('a layout rule of this view declares layout only', LAYOUT_PROPERTIES.has(property) && !COLOUR.test(value), `${property}: ${value}`);
    }
    check('the view has decorations', decorations.length > 0 && written('codegraph-decorations').length > 0);
    check('the decoration block is one declaration to a line', otherLines('codegraph-decorations').length === 0, otherLines('codegraph-decorations').join(' / '));
    for (const rule of decorations) {
      check('a decoration touches only what is this view\'s own', /^\.storage-[a-z-]+(?:\[[^\]]+\])?(?:::[a-z]+)?$/.test(rule.selectorText), rule.selectorText);
    }
    for (const [, property, value] of written('codegraph-decorations')) {
      const at = `${property}: ${value}`;
      if (DECORATION_COLOUR.has(property)) {
        // `currentColor` is the colour of the text, not a colour of its own.
        check('a decoration takes its colour from a token', (value.includes('var(--') || value === 'currentColor') && !COLOUR.test(value), at);
        for (const [, name] of value.matchAll(/var\((--[a-z0-9-]+)/g)) check('a decoration names a token the contract defines', tokens.has(name), name);
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
      if (name.startsWith('storage')) check('a class of this view is declared by its own blocks', ownClasses.has(`.${name}`), name);
      else check('a class the page uses is a utility of the contract', contractClasses.has(`.${name}`), name);
    }

    // ------------------------------------------------------------------ first paint

    check('language of the document', document.documentElement.lang === run.lang, document.documentElement.lang);
    check('title', document.title === text.title, document.title);
    check('free after the first answer', main.getAttribute('aria-busy') === 'false');
    check('the heading, and the line under it', $('storage-title').textContent === text.title && $('storage-subtitle').textContent === text.subtitle);
    check('refresh is on screen from the start, and named', !$('storage-refresh').hidden && $('storage-refresh-label').textContent === text.refresh);
    const numbers = ['stat-projects', 'stat-size', 'stat-files'].map((id) => $(id).textContent).join('|');
    check('the three numbers', numbers === [String(first.totals.projects), first.totals.size, String(first.totals.files)].join('|'), numbers);
    const numberNames = ['stat-projects', 'stat-size', 'stat-files'].map((id) => $(`${id}-label`).textContent).join('|');
    check('each number is named', numberNames === [text.statProjects, text.statSize, text.statFiles].join('|'), numberNames);
    check('the store is shown, under its heading', laidOut('storage-store') && $('store-heading-label').textContent === text.storeHeading && $('storage-dir-value').textContent === first.storeDir && $('storage-dir-value').title === first.storeDir);
    check('with two ways to get at it', $('storage-open-label').textContent === text.openDir && $('storage-copy-label').textContent === text.copyPath);
    check('the list is a section of its own', laidOut('storage-indexes') && $('indexes-heading').textContent === text.indexesHeading && $('indexes-hint').textContent === text.indexesHint);
    const headers = ['col-project', 'col-state', 'col-size', 'col-used', 'col-actions'].map((id) => $(id).textContent);
    check('column headers in the session language', JSON.stringify(headers) === JSON.stringify(Object.values(text.columns)), headers.join(' | '));
    check('one row per index', rows() === first.rows.length, `${rows()} of ${first.rows.length}`);
    check('what is due is counted', !$('storage-due').hidden && $('storage-due').textContent === text.due, $('storage-due').textContent);
    check('and the clean button says how many', $('storage-clean-label').textContent === text.cleanLabel && text.cleanLabel !== text.clean, $('storage-clean-label').textContent);
    check('nothing is being asked yet', main.querySelector('[data-action="confirm-delete"]') === null && $('storage-confirm-clean').hidden);
    check('the policy is a section with its explanation', $('policy-title').textContent === text.policyHeading && $('policy-hint').textContent === text.policyHint && $('policy-save').textContent === text.save);

    for (const [index, item] of first.rows.entries()) {
      const tr = row(item.key);
      if (!tr) {
        check('a row for every index', false, item.key);
        continue;
      }
      check('in the order the extension sends them', $('storage-rows').children[index] === tr, item.key);
      const chip = tr.querySelector('.storage-path-code');
      check('a path is shown as text, whole in its tooltip', chip.textContent === item.path && chip.title === item.path, item.key);
      const label = tr.querySelector('.storage-state');
      check('a state is a label in the colour of that state', label.dataset.state === item.state && label.textContent === item.stateLabel && label.querySelector('.storage-dot[aria-hidden="true"]') !== null, item.key);
      const [size, count] = tr.children[2].children;
      check('size with its file count', `${size.textContent}|${count?.textContent ?? ''}` === `${item.size}|${item.filesText}`, item.key);
      check('and when it was last used', tr.children[3].textContent === item.used, item.key);
      check('notes under the path', JSON.stringify([...tr.querySelectorAll('.storage-notes li')].map((li) => li.textContent)) === JSON.stringify(item.notes), item.key);
      const remove = inRow(item.key, 'delete');
      check('a row can be removed exactly when the extension allows it', (remove !== null && !remove.disabled) === item.removable, item.key);
      if (!item.removable) check('a blocked row says why on its button', remove.title === text.blocked[item.blocked], remove.title);
      check('the state, the size, the count and the date each stay on one line', [label, size, count, tr.children[3]].filter(Boolean).every((node) => textLines(node) === 1), item.key);
      // What a clamped box hides still has a place in the layout, so its lines are counted on
      // the height it shows, not on where its text sits.
      const style = getComputedStyle(chip);
      const shownLines = (chip.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
      check('a path shows at most two lines, inside its cell', Math.round(shownLines) <= 2 && chip.getBoundingClientRect().width <= tr.children[0].getBoundingClientRect().width + 0.5, `${shownLines.toFixed(1)} lines`);
    }
    const last = first.rows.at(-1);
    check('the workspace of a draft session is named for what it is and comes last', last.transient === true && row(keys.draft) === $('storage-rows').lastElementChild && row(keys.draft).textContent.includes(last.notes[0]));
    // Not only is each label marked with its state: states that differ are told apart by colour.
    const inkOf = (key) => getComputedStyle(row(key).querySelector('.storage-state')).color;
    check('ready, building and error are three different colours', new Set([keys.victim, keys.busy, keys.broken].map(inkOf)).size === 3, [keys.victim, keys.busy, keys.broken].map(inkOf).join(' | '));

    for (const cell of main.querySelectorAll('th')) check('a column header has text, and keeps it on one line', cell.textContent.trim() !== '' && textLines(cell) === 1);
    for (const control of visibleControls()) {
      if (control.tagName === 'BUTTON') check('a button has a name', control.textContent.trim() !== '', control.id);
      else check('a field has exactly one label', control.labels?.length === 1 && control.labels[0].textContent.trim() !== '', control.id);
    }

    // ------------------------------------------------------------------ icons and decorations

    const iconSize = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--icon-size'));
    const icons = [...main.querySelectorAll('svg.storage-icon')];
    check('every icon is drawn from a symbol', icons.length === 9 && icons.every((icon) => icon.querySelector('use') && icon.getAttribute('aria-hidden') === 'true'), String(icons.length));
    for (const icon of icons) {
      const box = icon.getBoundingClientRect();
      // The box of an `<svg>` is the same whether its symbol exists or not; the drawing has a size of its own.
      const drawn = icon.getBBox();
      check('an icon has a drawing in it', drawn.width > 0 && drawn.height > 0, `${drawn.width} x ${drawn.height}`);
      check('an icon is the size the contract names', Math.abs(box.width - iconSize) < 0.5 && Math.abs(box.height - iconSize) < 0.5, `${box.width} x ${box.height}`);
      check('and takes the colour of the text it sits with', getComputedStyle(icon).stroke === getComputedStyle(icon).color && getComputedStyle(icon).color === getComputedStyle(icon.parentElement).color);
    }
    for (const id of ['indexes-heading', 'policy-title']) {
      const before = getComputedStyle($(id), '::before');
      check('a section title has its bar', parseFloat(before.width) > 0 && parseFloat(before.height) > 0 && read(before.backgroundColor).a > 0, `${id}: ${before.width} x ${before.height} ${before.backgroundColor}`);
    }
    const tiles = [...main.querySelectorAll('.storage-icon-tile')];
    check('an icon sits on a tinted tile', tiles.length === 4 && tiles.every((tile) => read(getComputedStyle(tile).backgroundColor).a > 0), String(tiles.length));

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
      return Math.round((((high + 0.05) / (low + 0.05)) * 100)) / 100;
    };
    const fits = () => {
      const root = document.documentElement;
      check('the page does not scroll sideways', root.scrollWidth <= root.clientWidth, `${root.scrollWidth} > ${root.clientWidth}`);
      const wide = [...main.querySelectorAll('*')].filter((element) => {
        if (element.closest('.table-responsive') && !element.classList.contains('table-responsive')) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > window.innerWidth + 0.5 || box.left < -0.5);
      });
      check('nothing sticks out of the window (a wide table scrolls inside its own box)', wide.length === 0, wide.map((element) => `${element.tagName}.${element.className}`).join(', '));
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
      // Icons and bars are shapes: they need 3:1 against what they sit on.
      for (const icon of icons) {
        const value = ratio(read(getComputedStyle(icon).color), backgroundOf(icon));
        check(`an icon stands out from its background in ${label}`, value >= 3, `${value}:1`);
        metrics[`${label}IconContrast`] = Math.min(metrics[`${label}IconContrast`] ?? Infinity, value);
      }
    };
    metrics.viewport = window.innerWidth;
    fits();
    reportContrast(run.theme);

    // ------------------------------------------------------------------ delete asks first

    click(inRow(keys.victim, 'delete'));
    await tick();
    check('the first press asks', inRow(keys.victim, 'confirm-delete') && callCount('remove') === 0);
    check('and says what removing means', row(keys.victim).textContent.includes(text.confirmHint));
    check('focus goes to the question', focused()?.dataset.action === 'confirm-delete', focused()?.outerHTML.slice(0, 60));
    main.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    check('Escape withdraws the question', !inRow(keys.victim, 'confirm-delete') && callCount('remove') === 0);
    check('focus returns to the button', focused()?.dataset.action === 'delete' && focused().closest('tr')?.dataset.key === keys.victim);

    click(inRow(keys.victim, 'delete'));
    await tick();
    click(inRow(keys.victim, 'confirm-delete'));
    await tick();
    const removal = calls.find((call) => call.name === 'remove');
    check('the second press removes that index and no other', JSON.stringify(removal?.args) === JSON.stringify({ key: keys.victim }), JSON.stringify(removal?.args));
    check('nothing is asked any more', main.querySelector('[data-action="confirm-delete"]') === null);
    check('the store is the one the answer brought', row(keys.victim) === null && rows() === run.answers.remove[0].data.rows.length, rows());
    check('the result is said', $('storage-status').textContent === run.answers.remove[0].message, $('storage-status').textContent);
    check('focus stays inside the view', main.contains(focused()), focused()?.outerHTML.slice(0, 60));

    // A refusal keeps the index and is said in the error colour.
    const refused = run.answers.remove[1];
    click(inRow(keys.keyOnly, 'delete'));
    await tick();
    click(inRow(keys.keyOnly, 'confirm-delete'));
    await tick();
    check('a refusal keeps the index', row(keys.keyOnly) !== null);
    check('and is said as a failure', $('storage-status').textContent === refused.message && $('storage-status').classList.contains('text-destructive'), $('storage-status').textContent);

    // ------------------------------------------------------------------ clean asks first

    click($('storage-clean'));
    await tick();
    check('cleaning asks first', !$('storage-confirm-clean').hidden && $('storage-clean').hidden && callCount('clean') === 0);
    check('focus goes to the question', focused()?.id === 'storage-confirm-clean');
    click($('storage-cancel-clean'));
    await tick();
    check('the question can be withdrawn', !$('storage-clean').hidden && callCount('clean') === 0 && focused()?.id === 'storage-clean');
    click($('storage-clean'));
    await tick();
    click($('storage-confirm-clean'));
    await tick();
    const cleaned = run.answers.clean[0];
    check('the second press calls clean once', callCount('clean') === 1);
    check('the store after cleaning', rows() === cleaned.data.rows.length && $('storage-status').textContent === cleaned.message);
    check('with nothing due, there is nothing to press', $('storage-clean').disabled && $('storage-due').hidden && $('storage-clean-label').textContent === cleaned.data.text.cleanLabel);

    // ------------------------------------------------------------------ the policy

    $('policy-idle').value = '30';
    $('policy-form').requestSubmit();
    await tick();
    const policy = calls.find((call) => call.name === 'policy');
    check('saving sends both limits', JSON.stringify(policy?.args) === JSON.stringify({ maxIdleDays: 30, maxTotalMB: cleaned.data.policy.maxTotalMB }), JSON.stringify(policy?.args));
    check('the page shows the saved policy', $('policy-idle').value === String(run.answers.policy[0].data.policy.maxIdleDays) && $('storage-status').textContent === run.answers.policy[0].message);
    const before = callCount('policy');
    $('policy-idle').value = '-1';
    $('policy-form').requestSubmit();
    await tick();
    check('a negative limit is stopped by its field', callCount('policy') === before && $('policy-idle').validity.rangeUnderflow);

    // ------------------------------------------------------------------ a call that fails, and the way back

    const kept = rows();
    state.failNext = 'Extension view was closed';
    click($('storage-refresh'));
    await tick();
    check('a failed call is said as an error', $('storage-error').textContent === `${run.expect.failed}Extension view was closed`, $('storage-error').textContent);
    check('with a way back', !$('storage-retry').hidden && !$('storage-retry').disabled && !$('storage-status').textContent);
    check('and the last good store stays on screen', rows() === kept);
    click($('storage-retry'));
    await tick();
    check('trying again recovers', $('storage-error').textContent === '' && $('storage-retry').hidden && rows() === run.answers.list[1].data.rows.length, `${$('storage-error').textContent} | ${rows()} rows`);

    // ------------------------------------------------------------------ the other theme

    state.theme = run.otherTheme;
    window.dispatchEvent(new Event('zcode:globals'));
    await tick();
    check('a theme switch is followed', document.documentElement.getAttribute('data-theme') === run.otherTheme);
    const probe = document.createElement('i');
    probe.style.color = run.variables[run.otherTheme]['--color-text-primary'];
    document.body.append(probe);
    check('and so is the text colour', getComputedStyle($('storage-title')).color === getComputedStyle(probe).color, getComputedStyle($('storage-title')).color);
    probe.remove();
    fits();
    reportContrast(run.otherTheme);

    // ------------------------------------------------------------------ a limit the file fixed

    click($('storage-refresh'));
    await tick();
    const fixed = run.answers.list[2].data;
    check('a limit fixed by the file cannot be typed', $('policy-idle').disabled && !$('policy-quota').disabled);
    check('and the page says where it can be changed', !$('policy-note').hidden && $('policy-note').textContent === fixed.text.fixedByFile && $('policy-idle').getAttribute('aria-describedby') === 'policy-note');
    $('policy-quota').value = '512';
    $('policy-form').requestSubmit();
    await tick();
    const lastPolicy = calls.filter((call) => call.name === 'policy').at(-1);
    check('only the limit that can be changed is sent', JSON.stringify(lastPolicy?.args) === JSON.stringify({ maxTotalMB: 512 }), JSON.stringify(lastPolicy?.args));

    // ------------------------------------------------------------------ an answer without the new store

    // The index was removed, but the store could not be read again: no `data` comes along.
    const reads = callCount('list');
    click(inRow(keys.victim, 'delete'));
    await tick();
    click(inRow(keys.victim, 'confirm-delete'));
    await tick();
    check('the page reads the store again instead of guessing', callCount('list') === reads + 1, `${callCount('list')} reads, ${reads} before`);
    check('and shows what that read brought', row(keys.victim) === null && rows() === run.answers.list[3].data.rows.length, rows());
    check('the message of the action stays, and is not an error', $('storage-status').textContent === run.answers.remove[2].message && !$('storage-status').classList.contains('text-destructive'), $('storage-status').textContent);

    // ------------------------------------------------------------------ the store, outside the page

    const lists = callCount('list');
    // A file manager that does not start is said as an error, with the way back.
    state.failNext = 'Extension view was closed';
    click($('storage-open'));
    await tick();
    check('a file manager that does not start is said as an error', $('storage-error').textContent === `${run.expect.failed}Extension view was closed` && !$('storage-retry').hidden, $('storage-error').textContent);
    // From the keyboard: the button has the focus when it is pressed, and it is disabled while
    // the file manager starts.
    $('storage-open').focus();
    click($('storage-open'));
    await tick();
    check('opening the store asks the extension, and for nothing else', JSON.stringify(calls.at(-1)) === JSON.stringify({ name: 'open', args: {} }) && callCount('list') === lists, JSON.stringify(calls.at(-1)));
    check('and says that it did, clearing what went before', $('storage-status').textContent === run.answers.open[0].message && !$('storage-status').classList.contains('text-destructive') && $('storage-error').textContent === '' && $('storage-retry').hidden, `${$('storage-status').textContent} | ${$('storage-error').textContent}`);
    check('and the focus stays on the button that was pressed', focused()?.id === 'storage-open', focused()?.outerHTML.slice(0, 60));
    click($('storage-copy'));
    await tick();
    const said = $('storage-status').textContent;
    const shown = run.answers.list[3].data.storeDir;
    check('where the clipboard is refused, the path is selected and the page says so', said === text.copyManual && String(window.getSelection()) === shown, said);
    window.__codegraphClipboard.allow();
    click($('storage-copy'));
    await tick();
    check('where the clipboard works, the path is on it', $('storage-status').textContent === text.copied && JSON.stringify(window.__codegraphClipboard.written) === JSON.stringify([shown]), $('storage-status').textContent);

    // ------------------------------------------------------------------ an empty store

    click($('storage-refresh'));
    await tick();
    const empty = run.answers.list[4].data;
    check('an empty store says so', $('storage-table').hidden && !$('storage-empty').hidden && $('storage-empty').textContent === empty.text.empty, $('storage-empty').textContent);
    check('and counts nothing', [$('stat-projects').textContent, $('stat-files').textContent].join('|') === '0|0');
    check('with nothing to clean', $('storage-clean').disabled && $('storage-due').hidden && $('storage-clean-label').textContent === empty.text.cleanLabel);
  }

  window.__codegraphChecks = checks;
})();
