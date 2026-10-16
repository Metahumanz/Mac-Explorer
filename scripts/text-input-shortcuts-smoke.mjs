import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-text-keys-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(docs);
await fs.writeFile(path.join(docs, 'original.txt'), 'preserved fixture');
const git = (...args) => execFileSync('/usr/bin/git', ['-C', docs, ...args], { stdio: 'ignore' });
git('init'); git('add', 'original.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
await fs.writeFile(path.join(docs, 'staged.txt'), 'staged fixture'); git('add', 'staged.txt');
let app;
try {
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  await page.getByRole('option', { name: 'original.txt', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.textMenusIgnored = false;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const original = contents.setIgnoreMenuShortcuts.bind(contents);
    contents.setIgnoreMenuShortcuts = active => { globalThis.textMenusIgnored = active; original(active); };
  });
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.savedTextClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  const key = (value, shift = false) => page.keyboard.press(`Meta+${shift ? 'Shift+' : ''}${value}`);
  const clipboardText = () => app.evaluate(async ({ clipboard }) => await clipboard.readText());
  const editing = async (field, value) => {
    await field.fill(value); await field.focus();
    // CDP bypasses macOS menu lookup, so also assert the native suppression state.
    assert.equal(await app.evaluate(() => globalThis.textMenusIgnored), false);
    await key('a');
    await page.waitForFunction(() => { const e = document.activeElement; return e.selectionStart === 0 && e.selectionEnd === e.value.length; });
    await app.evaluate(({ clipboard }) => clipboard.writeText('before text copy'));
    await key('c');
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await clipboardText() === value) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await clipboardText(), value, 'Native Command+C must copy selected input text');
    await field.fill(''); await key('v');
    await page.waitForFunction(value => document.activeElement?.value === value, value);
    await key('a'); await key('x');
    await page.waitForFunction(() => document.activeElement?.value === '');
    assert.equal(await clipboardText(), value);
    await key('z');
    await page.waitForFunction(value => document.activeElement?.value === value, value);
  };
  await editing(page.getByRole('textbox', { name: '搜索文件', exact: true }), '搜索 clipboard 中文');
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
  await page.getByRole('option', { name: 'original.txt', exact: true }).click();
  await page.getByRole('button', { name: '重命名 (Return)', exact: true }).click();
  await editing(page.getByRole('textbox', { name: '名称', exact: true }), 'renamed.txt');
  await page.getByRole('textbox', { name: '名称', exact: true }).press('Escape');
  assert.equal(await fs.readFile(path.join(docs, 'original.txt'), 'utf8'), 'preserved fixture');
  await page.keyboard.press('Meta+Shift+g');
  await editing(page.getByRole('textbox', { name: '文件夹地址', exact: true }), '/temporary path with spaces');
  await page.getByRole('textbox', { name: '文件夹地址', exact: true }).press('Escape');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '文件夹', exact: true }).click();
  await editing(page.getByRole('textbox', { name: '名称', exact: true }), 'new folder clipboard');
  await page.getByRole('textbox', { name: '名称', exact: true }).press('Escape');
  await page.getByRole('option', { name: 'staged.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Git', exact: true }).click();
  await page.getByRole('menuitem', { name: '提交已暂存更改…', exact: true }).click();
  await editing(page.getByRole('textbox', { name: '提交信息', exact: true }), 'dialog clipboard\nsecond line');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('option', { name: 'original.txt', exact: true }).click();
  await key('c');
  await page.waitForFunction(() => window.explorer.clipboardGet().then(value => value.paths.some(file => file.endsWith('/original.txt'))));
  await key('v'); await page.getByRole('option', { name: 'original - 副本.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(docs, 'original - 副本.txt'), 'utf8'), 'preserved fixture');
  await page.evaluate(() => window.explorer.setOperationShortcuts({ copy: ['Command+Alt+C'], paste: [] }));
  await editing(page.getByRole('textbox', { name: '搜索文件', exact: true }), 'independent of file bindings');
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
  await page.getByRole('option', { name: 'original.txt', exact: true }).click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('file copy remains disabled'));
  await key('c'); assert.equal(await clipboardText(), 'file copy remains disabled');
  console.log('PASS: native menu suppression state and copy/paste/cut/select-all/undo in search, rename, address and dialog; file copy/paste and custom bindings remain separate; temporary files only.');
} finally {
  if (app) { await app.evaluate(async ({ clipboard }) => { if (globalThis.savedTextClipboard?.length) await clipboard.write(globalThis.savedTextClipboard); else clipboard.clear(); }).catch(() => {}); await app.close(); }
  await fs.rm(root, { recursive: true, force: true });
}
