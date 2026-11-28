// The plugin's files live in one folder of their own. They used to sit loose next to it; the
// first run after the move brings them along.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { bringAlong, paths } from '../src/paths.mjs';

const before = process.env.ZCODE_APPEARANCE_HOME;
afterEach(() => {
  if (before === undefined) delete process.env.ZCODE_APPEARANCE_HOME;
  else process.env.ZCODE_APPEARANCE_HOME = before;
});

describe('where the files are', () => {
  it('is one folder of the plugin\'s own under the data directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-paths-'));
    process.env.ZCODE_APPEARANCE_HOME = dir;
    try {
      assert.deepEqual(paths(), { dir: path.join(dir, 'appearance'), config: path.join(dir, 'appearance', 'config.json'), log: path.join(dir, 'appearance', 'launcher.log'), status: path.join(dir, 'appearance', 'status.json') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('brings the files that used to sit loose into the folder, once, and never over what is there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-paths-'));
    process.env.ZCODE_APPEARANCE_HOME = dir;
    try {
      fs.writeFileSync(path.join(dir, 'appearance.json'), '{"old": true}');
      fs.writeFileSync(path.join(dir, 'appearance.log'), 'old lines');
      fs.mkdirSync(path.join(dir, 'appearance'));
      fs.writeFileSync(path.join(dir, 'appearance', 'config.json'), '{"new": true}');
      bringAlong();
      assert.equal(fs.existsSync(path.join(dir, 'appearance.json')), true, 'a config already in the folder is kept, and the loose one with it');
      assert.equal(fs.readFileSync(path.join(dir, 'appearance', 'config.json'), 'utf8'), '{"new": true}');
      assert.equal(fs.existsSync(path.join(dir, 'appearance.log')), false, 'the log moved');
      assert.equal(fs.readFileSync(path.join(dir, 'appearance', 'launcher.log'), 'utf8'), 'old lines');
      bringAlong();
      assert.equal(fs.readFileSync(path.join(dir, 'appearance', 'launcher.log'), 'utf8'), 'old lines', 'and again changes nothing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when there is nothing to bring and nowhere to put it yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-paths-'));
    process.env.ZCODE_APPEARANCE_HOME = dir;
    try {
      bringAlong();
      assert.deepEqual(fs.readdirSync(dir), [], 'no folder is made for nothing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves what is odd about the file system alone instead of failing the start', () => {
    // The launcher, the server and the view all start through here; a folder of that name is
    // somebody else's, and a folder that is a file cannot be moved into.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-paths-'));
    process.env.ZCODE_APPEARANCE_HOME = dir;
    try {
      fs.mkdirSync(path.join(dir, 'appearance.log'));
      fs.writeFileSync(path.join(dir, 'appearance.json'), '{"old": true}');
      assert.deepEqual(bringAlong(), ['appearance.json'], 'the file moved, the folder of that name stayed');
      assert.equal(fs.statSync(path.join(dir, 'appearance.log')).isDirectory(), true);
      assert.equal(fs.readFileSync(path.join(dir, 'appearance', 'config.json'), 'utf8'), '{"old": true}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-paths-'));
    process.env.ZCODE_APPEARANCE_HOME = other;
    try {
      fs.writeFileSync(path.join(other, 'appearance'), 'a file where the folder should be');
      fs.writeFileSync(path.join(other, 'appearance.json'), '{"old": true}');
      assert.deepEqual(bringAlong(), [], 'nothing moved, nothing thrown');
      assert.equal(fs.readFileSync(path.join(other, 'appearance'), 'utf8'), 'a file where the folder should be');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
