// Path conventions shared by the server, the hooks and the indexer (src/paths.mjs): which folders
// are never a project of the user's — a home or drive root, and a workspace ZCode makes itself.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHostWorkspace, isHostWorkspacePath, resolveProjectRoot } from '../src/paths.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('isHostWorkspace', () => {
  test("a workspace under a .zcode directory's workspace folder, wherever ZCode keeps its data", () => {
    // The names are the ones ZCode gave its workspaces on this machine (2026-11-27).
    for (const root of [
      'D:/zcode-cache/.zcode/workspace/draft-62d72d80-6066-4336-88f9-db64d15fef8b',
      'D:/zcode-cache/.zcode/workspace/default',
      'D:/zcode-cache/.zcode/workspace/1795180696287-7cb3d179-7126-4305-a0a7-82373b7346f6',
      'D:/zcode-cache/.zcode/workspace',
      'D:/zcode-cache/.zcode/workspace/draft-62d72d80/src/deep',
      '/home/u/.zcode/workspace/draft-1',
      'D:/zcode-cache/.ZCode/Workspace/draft-1',
      // The rule is the folder, not who made it: nothing of the user's is kept under such a folder.
      'D:/codes/draft-editor/.zcode/workspace',
      'D:/codes/draft-editor/.zcode/workspace/src',
    ]) {
      assert.equal(isHostWorkspace(root), true, root);
    }
  });

  test('the rule on a path as written asks nothing of the filesystem, as the store needs it', () => {
    for (const root of ['D:/zcode-cache/.zcode/workspace/draft-1', 'D:/zcode-cache/.zcode/workspace\\default', '/home/u/.zcode/workspace']) {
      assert.equal(isHostWorkspacePath(root), true, root);
    }
    for (const root of ['D:/codes/zcode-plugin', 'D:/zcode-cache/.zcode/cli', 'D:/codes/.zcode/workspace-old/draft-1']) {
      assert.equal(isHostWorkspacePath(root), false, root);
    }
    // The store asks it of every stored root on each refresh and sweep: a filesystem that refuses
    // everything (an unplugged share) must not be asked at all.
    let asked = 0;
    const real = fs.realpathSync.native;
    fs.realpathSync.native = () => {
      asked += 1;
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    };
    try {
      assert.equal(isHostWorkspacePath('D:/zcode-cache/.zcode/workspace/draft-1'), true);
      assert.equal(isHostWorkspacePath('D:/codes/on-a-share/proj'), false);
    } finally {
      fs.realpathSync.native = real;
    }
    assert.equal(asked, 0);
  });

  test('a folder reached through a junction is recognised by its spelling as well as by its real path', (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-paths-link-'));
    dirs.push(base);
    // The data folder moved elsewhere and reached under a name that spells `.zcode/workspace`.
    const moved = path.join(base, 'moved-data');
    const draft = path.join(moved, 'workspace', 'draft-abc');
    fs.mkdirSync(draft, { recursive: true });
    const spelled = path.join(base, 'zcode-cache', '.zcode', 'workspace', 'draft-abc');
    fs.mkdirSync(path.join(base, 'zcode-cache'), { recursive: true });
    try {
      fs.symlinkSync(moved, path.join(base, 'zcode-cache', '.zcode'), 'junction');
    } catch (err) {
      t.skip(`a junction cannot be made here (${err.code})`);
      return;
    }
    // The junction resolves to the target, whose path does not spell it: only the spelling does.
    assert.doesNotMatch(fs.realpathSync.native(spelled), /\.zcode[\\/]workspace/i);
    assert.equal(isHostWorkspacePath(spelled), true, 'the spelling says it');
    assert.equal(isHostWorkspace(spelled), true, 'so the real path, which does not, does not hide it');
    assert.equal(resolveProjectRoot(spelled).hostWorkspace, true);
    // The other way round: a plain spelling whose real path is inside a workspace ZCode made.
    const realDraft = path.join(base, 'real-home', '.zcode', 'workspace', 'draft-xyz');
    fs.mkdirSync(realDraft, { recursive: true });
    const alias = path.join(base, 'alias');
    fs.symlinkSync(realDraft, alias, 'junction');
    assert.equal(isHostWorkspacePath(alias), false);
    assert.equal(isHostWorkspace(alias), true);
  });

  test('anything else is a project folder', () => {
    for (const root of [
      'D:/codes/zcode-plugin',
      'D:/codes/workspace/draft-1',
      'D:/codes/draft-editor/.zcode',
      'D:/zcode-cache',
      'D:/zcode-cache/.zcode',
      'D:/zcode-cache/.zcode/plugin-workspace',
      'C:/Users/u/.zcode',
      'C:/Users/u/.zcode/cli/plugins/data/codegraph@zcode-plugin',
    ]) {
      assert.equal(isHostWorkspace(root), false, root);
    }
  });
});

describe('resolveProjectRoot', () => {
  test('a workspace ZCode made is reported as such, with or without a subfolder, with or without a .git above', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-paths-'));
    dirs.push(base);
    const draft = path.join(base, '.zcode', 'workspace', 'draft-abc');
    fs.mkdirSync(path.join(draft, 'src'), { recursive: true });
    assert.deepEqual(resolveProjectRoot(draft), { root: path.resolve(draft), reason: 'cwd', unsafe: false, hostWorkspace: true });
    // A subfolder opened as the workspace is still inside the workspace ZCode made.
    assert.equal(resolveProjectRoot(path.join(draft, 'src')).hostWorkspace, true);
    // A .git in the folder that holds the workspaces does not make any of them a project.
    fs.mkdirSync(path.join(base, '.git'));
    assert.deepEqual(resolveProjectRoot(draft), { root: path.resolve(base), reason: 'git', unsafe: false, hostWorkspace: true });
  });

  test('a project is not one, and the answer is unchanged for it', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-paths-'));
    dirs.push(base);
    assert.deepEqual(resolveProjectRoot(base), { root: path.resolve(base), reason: 'cwd', unsafe: false, hostWorkspace: false });
  });
});
