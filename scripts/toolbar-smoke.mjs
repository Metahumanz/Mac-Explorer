import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nodeAPIHeaders from 'node-api-headers';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-toolbar-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(path.join(docs, 'folder'), { recursive: true });
for (let index = 0; index < 90; index++) await fs.writeFile(path.join(docs, `file-${String(index).padStart(3, '0')}.txt`), `fixture ${index}`);
const special = path.join(docs, '中文 空格 $test.txt');
await fs.writeFile(special, 'preserved special filename');
const output = path.resolve('artifacts/issue-5');
await fs.mkdir(output, { recursive: true });
const fixture = path.join(root, 'airdrop-fixture.node');
execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-DNAPI_VERSION=8', '-I', nodeAPIHeaders.include_dir, 'tests/fixtures/AirDropFixture.mm', '-o', fixture]);
execFileSync('codesign', ['--force', '--sign', '-', fixture]);
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('option', { name: 'file-000.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: '详细信息视图', exact: true }).click();
  await app.evaluate(({}, fixture) => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    globalThis.airDropFixture = require(fixture);
  }, fixture);
}
async function settings() {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置…', exact: true }).click();
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await page.getByRole('tab', { name: '自定义工具栏', exact: true }).click();
}
const options = () => page.getByRole('group', { name: '工具栏按钮', exact: true });
const names = target => target.locator('.command-tools button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
const closeSettings = () => page.getByRole('button', { name: '关闭设置', exact: true }).click();
const snapshot = () => app.evaluate(() => JSON.parse(globalThis.airDropFixture.snapshot()));
async function sticky() {
  await page.locator('.file-items').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await page.locator('.file-content').evaluate(element => { element.scrollTop = 900; });
  await page.waitForFunction(() => document.querySelector('.file-content').scrollTop > 800);
  const content = await page.locator('.file-content').boundingBox();
  const heading = await page.locator('.table-heading').boundingBox();
  assert.ok(Math.abs(content.y - heading.y) < 2, `header must stay visible: ${JSON.stringify({ content, heading })}`);
}
try {
  await launch();
  const native = process.env.EXPLORER_APP_PATH ? path.join(process.env.EXPLORER_APP_PATH, '../../Resources/app.asar.unpacked/dist-electron/native/defaults.node') : path.resolve('dist-electron/native/defaults.node');
  const rejected = await app.evaluate(({}, native) => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    const binding = require(native);
    return [null, [], ['relative'], [123], ['/tmp/a\0b']].map(input => { try { binding.airDrop(input); return false; } catch { return true; } });
  }, native);
  assert.ok(rejected.every(Boolean));
  assert.deepEqual(await names(page), ['剪切 (⌘X)', '复制 (⌘C)', '粘贴 (⌘V)', '重命名 (Return)', '共享', '移到回收站 (⌘⌫)']);
  await sticky();
  await page.locator('.table-heading').getByRole('button', { name: '修改日期', exact: true }).click();
  await sticky();
  await page.evaluate(() => localStorage.setItem('checkboxes', 'true'));
  await page.reload(); await page.getByRole('option', { name: 'file-000.txt', exact: true }).waitFor();
  await sticky();
  await page.getByRole('checkbox', { name: '全选文件', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=option][aria-selected=true]').length === 92);
  await page.getByRole('checkbox', { name: '全选文件', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'sticky-header-fixture.png') });
  await settings();
  await options().getByRole('checkbox', { name: '隔空投送', exact: true }).check();
  for (let index = 0; index < 6; index++) await page.getByRole('button', { name: '上移隔空投送', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '上移隔空投送', exact: true }).isDisabled(), true);
  assert.equal((await names(page))[0], '隔空投送');
  await options().getByRole('checkbox', { name: '在终端中打开', exact: true }).check();
  await options().evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'toolbar-settings-fixture.png') });
  await closeSettings();
  assert.equal(await page.getByRole('button', { name: '隔空投送', exact: true }).isDisabled(), true);
  await assert.rejects(page.evaluate(() => window.explorer.airDrop([])), /请选择/);
  await assert.rejects(page.evaluate(() => window.explorer.airDrop(['relative'])), /绝对路径/);
  await assert.rejects(page.evaluate(file => window.explorer.airDrop([file]), path.join(docs, 'missing.txt')), /不存在/);
  await page.getByRole('option', { name: 'file-000.txt', exact: true }).click();
  await page.getByRole('option', { name: 'file-001.txt', exact: true }).click({ modifiers: ['Meta'] });
  await page.getByRole('option', { name: '中文 空格 $test.txt', exact: true }).click({ modifiers: ['Meta'] });
  await page.getByRole('button', { name: '隔空投送', exact: true }).click();
  const first = await snapshot();
  assert.equal(first.service, 'com.apple.share.AirDrop.send'); assert.equal(first.calls, 1);
  assert.deepEqual(first.items.map(item => item.path).sort(), [path.join(docs, 'file-000.txt'), path.join(docs, 'file-001.txt'), special].sort());
  assert.ok(first.items.every(item => item.fileURL));
  await app.evaluate(() => globalThis.airDropFixture.setAvailable(false));
  await page.getByRole('button', { name: '隔空投送', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '当前无法使用隔空投送' }).waitFor();
  assert.equal((await snapshot()).calls, 1);
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  await app.evaluate(() => {
    const cp = process.getBuiltinModule('child_process'), util = process.getBuiltinModule('util');
    const run = util.promisify(cp.execFile); const spy = () => {};
    globalThis.terminalCalls = [];
    spy[util.promisify.custom] = async (command, args) => {
      if (command === '/usr/bin/open') { globalThis.terminalCalls.push(args); return { stdout: '', stderr: '' }; }
      return run(command, args);
    };
    cp.execFile = spy;
  });
  await page.getByRole('option', { name: 'folder', exact: true }).click();
  await page.getByRole('button', { name: '在终端中打开', exact: true }).click();
  const terminalCalls = await app.evaluate(async () => {
    for (let attempt = 0; attempt < 50 && !globalThis.terminalCalls.length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    return globalThis.terminalCalls;
  });
  assert.equal(terminalCalls[0]?.at(-1), path.join(docs, 'folder'));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('toolbar')));
  await app.close(); await launch(); assert.equal((await names(page))[0], '隔空投送');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('toolbar'))), saved);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ app }) => app.dock.getMenu().items.find(item => item.label === '新建窗口').click());
  const second = await opened; await second.getByRole('tab').waitFor();
  assert.equal((await names(second))[0], '隔空投送');
  await settings(); await options().getByRole('checkbox', { name: '复制', exact: true }).uncheck();
  await second.waitForFunction(() => !document.querySelector('.command-tools button[aria-label="复制 (⌘C)"]'));
  while (await options().getByRole('checkbox', { checked: true }).count()) await options().getByRole('checkbox', { checked: true }).first().uncheck();
  assert.deepEqual(await names(page), []); await closeSettings();
  assert.equal(await page.getByRole('button', { name: '更多', exact: true }).isVisible(), true);
  await settings(); await page.getByRole('button', { name: '恢复默认工具栏', exact: true }).click();
  assert.equal((await names(page)).length, 6);
  for (const name of ['隔空投送', '在终端中打开', '撤销', '刷新']) await options().getByRole('checkbox', { name, exact: true }).check();
  await closeSettings(); await page.evaluate(() => window.explorer.setTheme('dark'));
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(25, 25, 25)');
  const owner = await app.browserWindow(page); await owner.evaluate(window => window.setSize(800, 650));
  await page.waitForFunction(() => innerWidth <= 800);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const more = await page.getByRole('button', { name: '更多', exact: true }).boundingBox(); assert.ok(more.x + more.width <= 800);
  await page.screenshot({ path: path.join(output, 'toolbar-narrow-dark-fixture.png') });
  await page.evaluate(() => window.explorer.setLanguage('en'));
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings…', exact: true }).click();
  await page.getByRole('tab', { name: 'Customize toolbar', exact: true }).click();
  await page.getByRole('group', { name: 'Toolbar buttons', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'toolbar-english-dark-fixture.png') });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('toolbar', '{invalid'));
  await page.reload(); await page.getByRole('tab').waitFor(); assert.equal((await names(page)).length, 6);
  assert.equal(await fs.readFile(path.join(docs, 'file-000.txt'), 'utf8'), 'fixture 0');
  assert.equal(await fs.readFile(path.join(docs, 'file-001.txt'), 'utf8'), 'fixture 1');
  assert.deepEqual(errors, []);
  console.log('PASS: sticky headers and sort/select-all; toolbar show/hide/reorder/reset, restart/window sync, narrow/dark/English; AirDrop native service and file URLs with delivery stubbed, validation and unavailable service; terminal selected-folder arguments with launch stubbed. No files sent.');
} finally { await app?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
