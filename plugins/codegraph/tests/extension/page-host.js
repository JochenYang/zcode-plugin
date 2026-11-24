// A stand-in for ZCode around the storage view, and the checks run against it.
//
// tests/extension/page.test.mjs puts this script into a copy of ui/index.html, after a
// `window.__codegraphRun` setting, and opens the copy in a browser. The script answers the
// page's tool calls from data the test made with the real `viewData`, then uses the page the
// way a person would and reports everything that did not hold. Nothing here is shipped.
//
// window.__codegraphRun = {
//   answers: { list, remove, clean, policy },  one answer per call in order; the last repeats
//   variables: { light, dark },                what the host hands over as styles.variables
//   theme, otherTheme, locale, lang, keys,     the start state and the rows to act on
//   withoutHost, expect,                       a page opened outside ZCode, and what it should say
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

  async function runChecks(failures, metrics) {
    const check = (name, ok, detail = '') => {
      if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
    };
    const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
    const $ = (id) => document.getElementById(id);
    const main = $('codegraph-storage');
    const laidOut = (id) => $(id).getClientRects().length > 0;
    await tick(80);

    if (run.withoutHost) {
      const said = $('storage-error').textContent;
      check('outside ZCode the page says so', run.expect.noHost.includes(said), said);
      check('and offers to try again', !$('storage-retry').hidden && !$('storage-retry').disabled);
      check('and nothing else is on screen', !['storage-table', 'storage-empty', 'storage-actions', 'policy-form'].some(laidOut));
      $('storage-retry').click();
      await tick();
      check('trying again there says the same', $('storage-error').textContent === said, $('storage-error').textContent);
      return;
    }

    // While the answer is on its way.
    check('busy while the answer is on its way', main.getAttribute('aria-busy') === 'true');
    check('and it says so', $('storage-status').textContent === run.expect.loading, $('storage-status').textContent);
    check('nothing of the store is on screen yet', !['storage-table', 'storage-empty', 'storage-actions', 'policy-form'].some(laidOut));
    const pressable = [...document.querySelectorAll('button, input')].filter((control) => control.getClientRects().length > 0 && !control.disabled);
    check('nothing can be used yet', pressable.length === 0, pressable.map((control) => control.id).join(', '));
    check('nothing was asked for but the list', calls.length === 1 && calls[0].name === 'list', JSON.stringify(calls));
    state.release();
    await tick(80);

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

    // ------------------------------------------------------------------ the two stylesheets

    const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
    // Longhand names: the browser hands out shorthand declarations expanded.
    const LAYOUT_PROPERTIES = new Set([
      'align-items', 'column-gap', 'display', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap',
      'justify-content', 'list-style-image', 'list-style-position', 'list-style-type', 'margin-block-start', 'margin-bottom',
      'margin-left', 'margin-right', 'margin-top', 'max-width', 'min-width', 'overflow-wrap', 'padding-bottom', 'padding-left',
      'padding-right', 'padding-top', 'row-gap',
    ]);
    const styleRules = (list) => [...list].flatMap((rule) => [...(rule.style ? [rule] : []), ...(rule.cssRules ? styleRules(rule.cssRules) : [])]);
    const declarations = (style) => [...style].map((property) => ({ property, value: style.getPropertyValue(property) }));
    const contract = styleRules($('zcode-contract').sheet.cssRules);
    const layout = styleRules($('codegraph-layout').sheet.cssRules);

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
    for (const rule of layout) {
      for (const { property, value } of declarations(rule.style)) {
        check('a rule of this view declares layout only', LAYOUT_PROPERTIES.has(property) && !COLOUR.test(value), `${rule.selectorText} { ${property}: ${value} }`);
      }
    }

    // ------------------------------------------------------------------ first paint

    check('language of the document', document.documentElement.lang === run.lang, document.documentElement.lang);
    check('title', document.title === text.title, document.title);
    check('free after the first answer', main.getAttribute('aria-busy') === 'false');
    check('heading', $('storage-title').textContent === text.title);
    check('total line', $('storage-total').textContent === first.text.total, $('storage-total').textContent);
    check('the store is named', !$('storage-dir').hidden && $('storage-dir-value').textContent === first.storeDir);
    check('one row per index', rows() === first.rows.length, `${rows()} of ${first.rows.length}`);
    const headers = ['col-project', 'col-state', 'col-size', 'col-used', 'col-actions'].map((id) => $(id).textContent);
    check('column headers in the session language', JSON.stringify(headers) === JSON.stringify(Object.values(text.columns)), headers.join(' | '));
    check('what is due is counted', !$('storage-due').hidden && $('storage-due').textContent === first.text.due, $('storage-due').textContent);
    check('nothing is being asked yet', main.querySelector('[data-action="confirm-delete"]') === null && $('storage-confirm-clean').hidden);

    for (const item of first.rows) {
      const remove = inRow(item.key, 'delete');
      check('a row can be removed exactly when the extension allows it', (remove !== null && !remove.disabled) === item.removable, item.key);
      if (!item.removable) check('a blocked row says why on its button', remove.title === text.blocked[item.blocked], remove.title);
      check('a due row is marked as due', row(item.key).textContent.includes(text.dueNote) === item.due, item.key);
      const [project, state, size, used] = [...row(item.key).children];
      check('state, size and last use', [state.textContent, size.firstChild.textContent, used.textContent, project.querySelector('code').textContent].join('|') === [item.stateLabel, item.size, item.used, item.path].join('|'), item.key);
    }
    const stateCell = row(keys.broken).children[1];
    check('an error state is text in the error colour', stateCell.querySelector('.viz-badge') === null && stateCell.querySelector('.text-destructive')?.textContent === first.rows.find((item) => item.key === keys.broken).stateLabel);
    check('other states are badges', row(keys.victim).children[1].querySelector('.viz-badge') !== null);

    // Every class the page uses is a utility of the contract, or one of this view's layout
    // classes.
    const classesOf = (rules) => new Set(rules.flatMap((rule) => rule.selectorText?.match(/\.[a-z0-9_-]+/gi) ?? []));
    const contractClasses = classesOf(contract);
    const layoutClasses = classesOf(layout);
    for (const name of new Set([...document.querySelectorAll('[class]')].flatMap((element) => [...element.classList]))) {
      if (name.startsWith('storage')) check('a class of this view is laid out by its block', layoutClasses.has(`.${name}`), name);
      else check('a class the page uses is a utility of the contract', contractClasses.has(`.${name}`), name);
    }
    for (const element of main.querySelectorAll('button, input')) {
      if (!element.getClientRects().length || element.closest('[hidden]')) continue;
      if (element.tagName === 'BUTTON') check('a button has a name', element.textContent.trim() !== '', element.id);
      else check('a field has exactly one label', element.labels?.length === 1 && element.labels[0].textContent.trim() !== '', element.id);
    }
    for (const cell of main.querySelectorAll('th')) check('a column header has text', cell.textContent.trim() !== '');

    // The host's tokens reach the page: the same colour and size a plain element gets from them.
    const tokenColour = (theme) => {
      const probe = document.createElement('i');
      probe.style.color = run.variables[theme]['--color-text-primary'];
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    check('the host\'s text colour is used', getComputedStyle($('storage-title')).color === tokenColour(run.theme), getComputedStyle($('storage-title')).color);
    check('the host\'s font size is used', getComputedStyle(document.body).fontSize === run.variables[run.theme]['--font-text-md-size'], getComputedStyle(document.body).fontSize);
    check('the theme attribute follows the host', document.documentElement.getAttribute('data-theme') === run.theme);

    // ------------------------------------------------------------------ fitting and contrast

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
    const contrast = () => {
      // Any colour the engine understands (oklch, color-mix, relative) as sRGB: paint it and
      // read the pixel back.
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const parse = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: alpha / 255 };
      };
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
          const colour = parse(getComputedStyle(node).backgroundColor);
          if (colour.a > 0) {
            layers.push(colour);
            if (colour.a === 1) break;
          }
        }
        let base = { r: 255, g: 255, b: 255 };
        for (const layer of layers.reverse()) base = over({ ...layer, a: layer.a ?? 1 }, { ...base, a: 1 });
        return base;
      };
      const report = [];
      for (const element of main.querySelectorAll('*')) {
        if (!element.getClientRects().length || element.closest(':disabled') || element.closest('[hidden]')) continue;
        if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')) continue;
        const background = backgroundOf(element);
        const colour = parse(getComputedStyle(element).color);
        const ink = colour.a < 1 ? over(colour, background) : colour;
        const [high, low] = [luminance(ink), luminance(background)].sort((a, b) => b - a);
        report.push({ name: `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 20)}"`, kind: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/).join('.')}` : ''}`, ratio: Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100 });
      }
      return report;
    };
    const reportContrast = (label) => {
      const report = contrast();
      // The lowest ratio of each kind of element, for whoever reads a failure.
      const lowest = {};
      for (const item of report) lowest[item.kind] = Math.min(lowest[item.kind] ?? Infinity, item.ratio);
      metrics[`${label}Contrast`] = Object.fromEntries(Object.entries(lowest).sort((a, b) => a[1] - b[1]));
      for (const item of report) check(`text meets WCAG AA in ${label}`, item.ratio >= 4.5, `${item.name} ${item.ratio}:1`);
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
    check('with nothing due, there is nothing to press', $('storage-clean').disabled && $('storage-due').hidden);

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
    check('and so is the text colour', getComputedStyle($('storage-title')).color === tokenColour(run.otherTheme), getComputedStyle($('storage-title')).color);
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
    const last = calls.filter((call) => call.name === 'policy').at(-1);
    check('only the limit that can be changed is sent', JSON.stringify(last?.args) === JSON.stringify({ maxTotalMB: 512 }), JSON.stringify(last?.args));

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

    // ------------------------------------------------------------------ an empty store

    click($('storage-refresh'));
    await tick();
    const empty = run.answers.list[4].data;
    check('an empty store says so', $('storage-table').hidden && !$('storage-empty').hidden && $('storage-empty').textContent === empty.text.empty, $('storage-empty').textContent);
    check('with nothing to clean', $('storage-clean').disabled && $('storage-due').hidden);
  }

  window.__codegraphChecks = checks;
})();
