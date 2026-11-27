import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  MEDIA_EXTENSIONS,
  ROTATE_MAX_MINUTES,
  applyPatch,
  ConfigError,
  defaultConfig,
  loadConfig,
  mediaAt,
  mediaKind,
  normalizeMediaPath,
  saveConfig,
  validateConfig,
} from '../src/config.mjs';

const inTempDir = (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-config-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('appearance config', () => {
  it('starts from defaults', () => {
    const config = defaultConfig();
    assert.equal(config.background.enabled, true);
    assert.equal(config.background.scope, 'page');
    assert.equal(config.background.mask, 0.72);
    assert.deepEqual(config.background.media, []);
    assert.equal(config.skin.preset, 'default');
    assert.equal(config.launcher.port, 9337);
    assert.notEqual(config, defaultConfig(), 'a caller may change its own copy');
  });

  it('reads a missing file as defaults', () => inTempDir((dir) => {
    const { config, exists, file } = loadConfig({ file: path.join(dir, 'none.json') });
    assert.equal(exists, false);
    assert.deepEqual(config, defaultConfig());
    assert.ok(file.endsWith('none.json'));
  }));

  it('names the file when it does not parse', () => inTempDir((dir) => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ "background": ');
    assert.throws(() => loadConfig({ file }), (err) => err instanceof ConfigError && err.file === file && /not valid JSON/.test(err.message));
  }));

  it('rejects what it does not understand instead of ignoring it', () => {
    const problems = (raw) => {
      try {
        validateConfig(raw);
      } catch (err) {
        return err.problems;
      }
      return [];
    };
    assert.deepEqual(problems({ wallpapers: [] }), ['unknown section wallpapers']);
    // The list was called `images` before videos came; the old name is a mistake to report, not to guess at.
    assert.deepEqual(problems({ background: { images: [] } }), ['unknown setting background.images']);
    assert.deepEqual(problems({ background: { colour: 'red' } }), ['unknown setting background.colour']);
    assert.deepEqual(problems({ skin: { theme: 'x' } }), ['unknown setting skin.theme']);
    assert.deepEqual(problems({ launcher: { debug: true } }), ['unknown setting launcher.debug']);
  });

  it('checks ranges and shapes', () => {
    const message = (raw) => {
      try {
        validateConfig(raw);
      } catch (err) {
        return err.message;
      }
      return '';
    };
    assert.match(message({ background: { mask: 1.5 } }), /background\.mask must be a number from 0 to 1/);
    assert.match(message({ background: { mask: 'high' } }), /background\.mask/);
    assert.match(message({ background: { blur: 41 } }), /background\.blur must be an integer from 0 to 40/);
    assert.match(message({ background: { blur: 2.5 } }), /background\.blur/);
    assert.match(message({ background: { rotateMinutes: -1 } }), /background\.rotateMinutes must be an integer/);
    // A longer interval than the timer can hold would fire at once, over and over.
    assert.match(message({ background: { rotateMinutes: ROTATE_MAX_MINUTES + 1 } }), /background\.rotateMinutes must be an integer from 0 to 525600/);
    assert.equal(message({ background: { rotateMinutes: ROTATE_MAX_MINUTES } }), '', 'the year itself is fine');
    assert.match(message({ background: { scope: 'window' } }), /background\.scope must be one of page, chat/);
    assert.match(message({ background: { enabled: 'yes' } }), /background\.enabled/);
    assert.match(message({ background: { media: 'a.png' } }), /background\.media must be a list/);
    assert.match(message({ skin: { preset: 'solarized' } }), /skin\.preset must be one of default, midnight, sepia/);
    assert.match(message({ skin: { custom: { dark: { base: 'red' } } } }), /skin\.custom\.dark\.base must be a hex colour/);
    assert.match(message({ skin: { custom: { dark: { shadow: '#111111' } } } }), /skin\.custom\.dark: unknown colour shadow/);
    assert.match(message({ skin: { custom: { night: {} } } }), /skin\.custom: unknown mode night/);
    assert.match(message({ skin: { custom: {} } }), /skin\.custom needs a light or a dark set/);
    assert.match(message({ launcher: { port: 70000 } }), /launcher\.port/);
    // Port 0 means "any port" to the system and nothing useful to this launcher.
    assert.match(message({ launcher: { port: 0 } }), /launcher\.port must be an integer from 1 to 65535/);
    assert.equal(message({ launcher: { port: 1 } }), '');
    assert.match(message([]), /must be a JSON object/);
  });

  it('turns media paths absolute and refuses what is neither a picture nor a video', () => inTempDir((dir) => {
    assert.equal(normalizeMediaPath('walls/a.png', { cwd: dir }), path.join(dir, 'walls', 'a.png'));
    assert.equal(normalizeMediaPath('WALLS/A.PNG', { cwd: dir }), path.join(dir, 'WALLS', 'A.PNG'));
    assert.equal(normalizeMediaPath(path.join(dir, 'b.MP4'), { cwd: dir }), path.join(dir, 'b.MP4'));
    assert.throws(() => normalizeMediaPath('clip.mkv', { cwd: dir }), /not a picture or a video/);
    assert.throws(() => normalizeMediaPath('notes.txt', { cwd: dir }), /not a picture or a video/);
    assert.throws(() => normalizeMediaPath('   ', { cwd: dir }), /non-empty string/);
    assert.equal(normalizeMediaPath('~/x.webm', { cwd: dir }), path.join(os.homedir(), 'x.webm'));
  }));

  it('refuses a network path, whichever way it is spelled, from the file and from the tools', () => inTempDir((dir) => {
    for (const spelled of ['\\\\server\\share\\a.png', '//server/share/a.png', '  \\\\127.0.0.1\\c$\\a.png  ']) {
      assert.throws(() => normalizeMediaPath(spelled, { cwd: dir }), /network path is not accepted/, spelled);
      assert.throws(() => applyPatch(defaultConfig(), { setMedia: [spelled] }, { cwd: dir }), /network path is not accepted/, spelled);
      assert.throws(() => applyPatch(defaultConfig(), { addMedia: [spelled] }, { cwd: dir }), /network path is not accepted/, spelled);
      const file = path.join(dir, 'appearance.json');
      fs.writeFileSync(file, JSON.stringify({ background: { media: [spelled] } }));
      assert.throws(() => loadConfig({ file }), /network path is not accepted/, spelled);
    }
    // A share mapped to a drive letter is a local path.
    assert.equal(normalizeMediaPath('Z:\\photos\\a.png', { cwd: dir }), path.win32.resolve('Z:\\photos\\a.png'));
    if (process.platform === 'win32') {
      // A workspace that is itself on a share: every path resolves onto the network, however it
      // is spelled. (This is what the check after resolving is for; the one before it is what
      // holds on macOS and Linux, where such a path resolves to a local one.)
      assert.throws(() => normalizeMediaPath('a.png', { cwd: '\\\\server\\share\\pics' }), /network path is not accepted/);
    }
  }));

  it('tells a picture from a video by its extension', () => {
    assert.equal(mediaKind('a.png'), 'picture');
    assert.equal(mediaKind('a.JPEG'), 'picture');
    assert.equal(mediaKind('a.mp4'), 'video');
    assert.equal(mediaKind('a.webm'), 'video');
    assert.equal(mediaKind('a.mkv'), null);
    assert.deepEqual([...MEDIA_EXTENSIONS].slice(-2), ['.mp4', '.webm']);
  });

  it('saves and loads back what it validated', () => inTempDir((dir) => {
    const file = path.join(dir, 'nested', 'appearance.json');
    const config = defaultConfig();
    config.background.media = [path.join(dir, 'a.png'), path.join(dir, 'b.mp4')];
    config.background.mask = 0.4;
    saveConfig(config, { file });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'), 'ends with a newline');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['appearance.json'], 'no temporary file is left behind');
    assert.deepEqual(loadConfig({ file }).config, config);
  }));

  describe('partial updates', () => {
    it('changes only what was passed', () => {
      // Started from values that are not the defaults, so that "kept" cannot be mistaken for "reset".
      const config = applyPatch(defaultConfig(), { blur: 7, skin: 'sepia', rotateMinutes: 30 }, { cwd: '/nowhere' });
      const next = applyPatch(config, { mask: 0.3, scope: 'chat' }, { cwd: '/nowhere' });
      assert.equal(next.background.mask, 0.3);
      assert.equal(next.background.scope, 'chat');
      assert.equal(next.background.blur, 7, 'untouched');
      assert.equal(next.background.rotateMinutes, 30, 'untouched');
      assert.equal(next.skin.preset, 'sepia', 'untouched');
      assert.equal(config.background.mask, 0.72, 'the input is not changed');
    });

    it('replaces, adds and removes files', () => inTempDir((dir) => {
      const a = path.join(dir, 'a.png');
      const b = path.join(dir, 'b.mp4');
      let config = applyPatch(defaultConfig(), { setMedia: [a] });
      assert.deepEqual(config.background.media, [a]);
      config = applyPatch(config, { addMedia: ['b.mp4', a.toUpperCase()] }, { cwd: dir });
      assert.deepEqual(config.background.media, [a, b], 'a repeated file is not added twice');
      config = applyPatch(config, { removeMedia: [1] });
      assert.deepEqual(config.background.media, [b]);
      config = applyPatch(config, { removeMedia: ['b.mp4'] }, { cwd: dir });
      assert.deepEqual(config.background.media, []);
    }));

    it('refuses a field it does not have', () => {
      assert.throws(() => applyPatch(defaultConfig(), { opacity: 0.5 }), /unknown field opacity/);
      assert.throws(() => applyPatch(defaultConfig(), { setMedia: 'a.png' }), /setMedia must be a list/);
      assert.throws(() => applyPatch(defaultConfig(), { removeMedia: [0] }), /removeMedia takes file paths or 1-based positions/);
      assert.throws(() => applyPatch(defaultConfig(), { skin: 'nope' }), /skin must be one of/);
      assert.throws(() => applyPatch(defaultConfig(), { setImages: [] }), /unknown field setImages/);
    });

    it('validates the result and leaves the input alone when it is wrong', () => {
      const config = defaultConfig();
      assert.throws(() => applyPatch(config, { mask: 5 }), /background\.mask must be a number from 0 to 1/);
      assert.throws(() => applyPatch(config, { addMedia: ['x.txt'] }), /not a picture or a video/);
      assert.equal(config.background.mask, 0.72);
    });

    it('sets a skin, a custom skin, and clears the custom one', () => {
      let config = applyPatch(defaultConfig(), { skin: 'midnight' });
      assert.equal(config.skin.preset, 'midnight');
      const custom = { dark: { base: '#101418', surface: '#181d25', text: '#e6e6e6', accent: '#38bdf8', border: '#2a303a' } };
      config = applyPatch(config, { skin: 'default', customSkin: custom });
      assert.equal(config.skin.preset, 'default');
      assert.deepEqual(config.skin.custom, custom);
      config = applyPatch(config, { customSkin: null });
      assert.equal(config.skin.custom, null);
    });
  });

  it('walks a media list round and round, saying what each one is', () => {
    const config = defaultConfig();
    assert.equal(mediaAt(config, 3), null);
    config.background.media = ['a.png', 'b.mp4', 'c.webp'];
    assert.deepEqual(mediaAt(config, 0), { path: 'a.png', kind: 'picture' });
    assert.deepEqual(mediaAt(config, 4), { path: 'b.mp4', kind: 'video' });
    assert.equal(mediaAt(config, -1).path, 'c.webp');
  });
});
