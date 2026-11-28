// The file dialog itself (src/extension/pick.mjs), with the program it starts replaced by one
// that answers. On Windows one case runs the real PowerShell, without opening a window: that
// the answer survives the console's code page, which a folder named in Chinese once did not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { pickFiles } from '../../src/extension/pick.mjs';
import { powershellExe } from '../../src/system.mjs';

const IN_CHINESE = 'E:\\设计稿\\dsh app startup\\DSH-APP 启动.mp4';
// What the dialog's script prints: the JSON in UTF-8, in base64.
const answer = (files) => Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
const windowsOnly = process.platform === 'win32' ? false : 'PowerShell is on Windows only';

describe('the file dialog', () => {
  it('on Windows: starts PowerShell by its full path with the script encoded, and reads the answer as it was written', async () => {
    const calls = [];
    const files = await pickFiles({
      platform: 'win32',
      title: '选择文件',
      initial: 'E:\\设计稿',
      run: async (command, args) => {
        calls.push({ command, args });
        return `${answer([IN_CHINESE, 'D:\\walls\\b.png'])}\r\n`;
      },
    });
    assert.deepEqual(files, [IN_CHINESE, 'D:\\walls\\b.png'], 'a path with characters outside the console\'s code page arrives whole');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, powershellExe());
    assert.equal(calls[0].args[0], '-NoProfile');
    assert.equal(calls[0].args[2], '-EncodedCommand');
    const script = Buffer.from(calls[0].args[3], 'base64').toString('utf16le');
    assert.ok(script.includes('ConvertTo-Json -InputObject @($dialog.FileNames) -Compress'), 'the names are turned into JSON');
    assert.ok(script.includes('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))'), 'and written as base64 of the UTF-8, not as text in the console\'s code page');
    // The title travels the other way, in base64 too.
    assert.ok(script.includes(Buffer.from('选择文件', 'utf8').toString('base64')));
    // The dialog opens in the folder of the files already listed, when it is a whole path.
    assert.ok(!script.includes('__INITIAL__'), 'the folder to open in is filled in');
    assert.ok(script.includes(Buffer.from('E:\\设计稿', 'utf8').toString('base64')));
    const relative = await pickFiles({ platform: 'win32', initial: 'walls', run: async () => answer([]) });
    assert.deepEqual(relative, []);
  });

  it('on Windows, an answer that is not what the script writes is said, not taken for a list', async () => {
    await assert.rejects(pickFiles({ platform: 'win32', run: async () => 'Add-Type : Cannot find type' }), /the file dialog answered something else/);
    assert.deepEqual(await pickFiles({ platform: 'win32', run: async () => answer([]) }), [], 'nothing chosen');
  });

  it('on macOS and Linux: the dialog of the desktop, one path a line or between bars', async () => {
    const seen = [];
    assert.deepEqual(await pickFiles({
      platform: 'darwin',
      run: async (command, args) => {
        seen.push([command, args.join(' ')]);
        return '/Users/a/设计稿/a.mp4\r\n/Users/a/b.png\r\n';
      },
    }), ['/Users/a/设计稿/a.mp4', '/Users/a/b.png']);
    assert.equal(seen[0][0], 'osascript');
    assert.ok(seen[0][1].includes('choose file'), 'the words of the dialog are in the script');
    assert.deepEqual(await pickFiles({
      platform: 'linux',
      run: async (command, args) => {
        seen.push([command, args.join(' ')]);
        return '/home/a/a.mp4|/home/a/b.png';
      },
    }), ['/home/a/a.mp4', '/home/a/b.png']);
    assert.equal(seen[1][0], 'zenity');
    await assert.rejects(pickFiles({ platform: 'freebsd', run: async () => '' }), /no file dialog on freebsd/);
  });

  it('the real PowerShell writes the answer so that it survives the console\'s code page', { skip: windowsOnly }, () => {
    // The output step of the dialog's script, on a name with Chinese in it; no window opens.
    const script = [
      `$names = @('${IN_CHINESE.replaceAll("'", "''")}')`,
      '$json = ConvertTo-Json -InputObject $names -Compress',
      '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))',
    ].join('\n');
    const out = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^[A-Za-z0-9+/=\r\n]+$/, 'letters and digits only, whatever the code page');
    assert.deepEqual(JSON.parse(Buffer.from(out.stdout.trim(), 'base64').toString('utf8')), [IN_CHINESE]);
  });
});
