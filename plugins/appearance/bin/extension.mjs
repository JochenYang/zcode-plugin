/**
 * appearance — extension code for the ZCode desktop app.
 *
 * This adds the one surface the launcher and the slash command cannot give: a view in the side
 * pane where every setting is a control that applies at once (ui/index.html), and the entry
 * that opens it. The view decides nothing on its own: each control is a tool call whose `run`
 * lives here, next to the config file, and what the page shows is what these tools answer.
 *
 * How a change reaches the window: a tool writes the config file; the launcher watches that
 * file's folder and injects the new stylesheet within a moment. This process never talks to the
 * window itself, so there is exactly one writer of styles and no two versions fighting.
 *
 * This process is shared with every other plugin's extension code: the file dialog is started
 * detached and its answer is collected later, never awaited inside a tool call.
 *
 * Runtime is zero-dependency: the host injects `ctx`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, defaultConfig, loadConfig, saveConfig } from '../src/config.mjs';
import { openWithDefaultApp } from '../src/open.mjs';
import { paths } from '../src/paths.mjs';
import { mediaInfo, viewData, viewStrings } from '../src/extension/describe.mjs';
import { pickFiles } from '../src/extension/pick.mjs';
import { launcherState } from '../src/status.mjs';

export const VIEW_ID = 'appearance.panel';
export const COMMAND_ID = 'appearance.panel';
export const TOOL_NAMES = Object.freeze(['get', 'set', 'add', 'remove', 'pick', 'reset', 'openConfig']);

/**
 * Activate the extension.
 *
 * @param {object} ctx  injected by the host
 * @param {{ file?: string, statusFile?: string, pick?: Function, open?: Function }} [deps]  tests replace the files, the dialog and the opener
 * @returns {Promise<{ dispose: () => void }>}
 */
export async function activate(ctx, { file = paths().config, statusFile = paths().status, pick = pickFiles, open = openWithDefaultApp } = {}) {
  const log = (message) => {
    try {
      if (typeof ctx?.log?.error === 'function') ctx.log.error(`appearance: ${message}`);
      else process.stderr.write(`appearance: ${message}\n`);
    } catch {
      // the log is a courtesy
    }
  };

  // The app's language. `env.get` is a call into the app that answers later, so it is awaited,
  // every time a line of copy is chosen: a change of language shows on the next answer. A host
  // without it, or a call that fails, gives nothing, and the page then goes by the system
  // language. (Read as if it answered at once, this gave the English copy on a Chinese app.)
  const locale = async () => {
    try {
      return (await ctx?.env?.get?.())?.locale ?? '';
    } catch {
      return '';
    }
  };
  // The view polls `get` while a file dialog is open; the answer is handed over once.
  let picked = null;
  let picking = false;
  let disposed = false;

  const data = async () => {
    const { config } = loadConfig({ file });
    return viewData(config, {
      media: await mediaInfo(config),
      launcher: launcherState(statusFile),
      locale: await locale(),
      file,
      pick: picked,
    });
  };
  const answer = async () => {
    const view = await data();
    picked = null;
    return { ok: true, data: view };
  };

  // A tool answers; it never throws. What it returns is the page's `structuredContent`.
  const tool = (description, inputSchema, run) => ({
    description,
    inputSchema,
    run: async (args) => {
      try {
        return await run(args ?? {});
      } catch (err) {
        log(`view tool: ${err?.message ?? err}`);
        return { ok: false, message: viewStrings(await locale()).failed + (err?.message ?? String(err)) };
      }
    },
  });

  // The shape of the patch `set` takes: the same fields as the MCP tool, without the media lists.
  const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
  const colourSet = {
    type: 'object',
    properties: Object.fromEntries(['base', 'surface', 'text', 'accent', 'border'].map((name) => [name, { type: 'string', description: `${name} colour, like #14181f` }])),
    additionalProperties: false,
  };

  try {
    ctx?.views?.register?.(VIEW_ID, {
      entry: 'ui/index.html',
      tools: {
        get: tool('The settings, the background files, the skins and every line of copy.', { type: 'object', properties: {} }, answer),
        set: tool(
          'Change settings. Pass only what changes.',
          {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              scope: { type: 'string', enum: ['page', 'chat'] },
              mask: number(0, 1),
              blur: { type: 'integer', minimum: 0 },
              rotateMinutes: { type: 'integer', minimum: 0 },
              skin: { type: 'string' },
              customSkin: { type: ['object', 'null'], properties: { light: colourSet, dark: colourSet }, additionalProperties: false },
            },
            additionalProperties: false,
          },
          async (args) => {
            const text = viewStrings(await locale());
            const { config } = loadConfig({ file });
            const next = applyPatch(config, args);
            saveConfig(next, { file });
            const view = await data();
            return { ok: true, message: text.saved, data: view };
          },
        ),
        add: tool('Add background files by path. Whole paths only: this process has no folder a relative path would make sense against.', { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['paths'] }, async ({ paths: pathsToAdd = [] }) => {
          const text = viewStrings(await locale());
          const relative = pathsToAdd.filter((entry) => typeof entry === 'string' && entry.trim() !== '' && !path.isAbsolute(entry.trim()) && !entry.trim().startsWith('~'));
          if (relative.length) return { ok: false, message: `${text.needFullPath}${relative[0]}` };
          const { config } = loadConfig({ file });
          let next;
          try {
            next = applyPatch(config, { addMedia: pathsToAdd });
          } catch (err) {
            return { ok: false, message: text.notFound + (err?.message ?? String(err)) };
          }
          const added = next.background.media.filter((item) => !config.background.media.some((existing) => existing === item));
          saveConfig(next, { file });
          return { ok: true, message: text.added(added), data: await data() };
        }),
        remove: tool('Remove one background file by its path.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, async ({ path: target }) => {
          const text = viewStrings(await locale());
          const { config } = loadConfig({ file });
          const next = applyPatch(config, { removeMedia: [target] });
          saveConfig(next, { file });
          return { ok: true, message: text.removed(String(target).split(/[\\/]/).pop()), data: await data() };
        }),
        pick: tool('Open the system file dialog. The chosen files are added when it closes; poll `get` for them.', { type: 'object', properties: {} }, async () => {
          const text = viewStrings(await locale());
          if (picking) return { ok: false, message: text.alreadyPicking };
          picking = true;
          picked = null;
          // Not awaited: a dialog can stay open for as long as the user likes.
          Promise.resolve()
            .then(() => pick({ title: text.pick.replace(/…$/, '') }))
            .then(async (files) => {
              if (disposed) return;
              if (!files.length) {
                picked = { files: [], message: text.pickNone };
                return;
              }
              const { config } = loadConfig({ file });
              let next;
              try {
                next = applyPatch(config, { addMedia: files });
              } catch (err) {
                picked = { files: [], error: String(err?.message ?? err), message: `${text.notFound}${err?.message ?? err}` };
                return;
              }
              saveConfig(next, { file });
              picked = { files, message: text.added(files) };
            })
            .catch((err) => {
              picked = { files: [], error: String(err?.message ?? err), message: `${text.failed}${err?.message ?? err}` };
              log(`file dialog: ${err?.message ?? err}`);
            })
            .finally(() => {
              picking = false;
            });
          return { ok: true, message: text.picking, data: await data() };
        }),
        reset: tool('Restore the default settings; background files stay.', { type: 'object', properties: {} }, async () => {
          const text = viewStrings(await locale());
          const { config } = loadConfig({ file });
          const next = defaultConfig();
          next.background.media = [...config.background.media];
          next.launcher = { ...config.launcher };
          saveConfig(next, { file });
          return { ok: true, message: text.resetDone, data: await data() };
        }),
        openConfig: tool('Open the settings file with its default app.', { type: 'object', properties: {} }, async () => {
          const text = viewStrings(await locale());
          if (!fs.existsSync(file)) saveConfig(loadConfig({ file }).config, { file });
          open(file);
          return { ok: true, message: text.opened };
        }),
      },
    });
  } catch (err) {
    log(`view: ${err?.message ?? err}`);
  }

  try {
    ctx?.commands?.register?.(COMMAND_ID, async () => {
      try {
        await ctx.views.open(VIEW_ID, 'app');
        return { ok: true };
      } catch (err) {
        log(`open view: ${err?.message ?? err}`);
        return { ok: false, message: viewStrings(await locale()).failed + (err?.message ?? String(err)) };
      }
    });
  } catch (err) {
    log(`command: ${err?.message ?? err}`);
  }

  return {
    /** For a host that shuts the extension down: a dialog that closes afterwards adds nothing. */
    dispose() {
      disposed = true;
    },
  };
}
