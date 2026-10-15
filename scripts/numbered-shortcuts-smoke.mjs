import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-numbered-keys-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(docs);
await fs.writeFile(path.join(docs, 'retained.txt'), 'Keep this content');
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN' } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('option', { name: 'retained.txt', exact: true }).waitFor();
}
const activeIndex = () => page.locator('.tabs [role=tab]').evaluateAll(tabs => tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
async function select(key, index) {
  await page.keyboard.press(key);
  await page.waitForFunction(index => [...document.querySelectorAll('.tabs [role=tab]')].findIndex(tab => tab.getAttribute('aria-selected') === 'true') === index, index);
}
async function settings() {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'Command+,').click());
  await page.getByRole('tab', { name: '键盘快捷键', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="唤醒快捷键"]').disabled);
}
const state = () => page.evaluate(() => window.explorer.settings());
try {
  await launch();
  await page.getByRole('option', { name: 'retained.txt', exact: true }).click();
  await select('Meta+8', 0); await select('Meta+9', 0);
  assert.equal(await page.getByRole('option', { name: 'retained.txt', exact: true }).getAttribute('aria-selected'), 'true');
  for (let count = 2; count <= 10; count++) {
    await page.keyboard.press('Meta+t');
    await page.waitForFunction(count => document.querySelectorAll('.tabs [role=tab]').length === count, count);
  }
  for (let number = 1; number <= 8; number++) await select(`Meta+${number}`, number - 1);
  await select('Meta+9', 9);
  await select('Control+Tab', 0); await select('Control+Shift+Tab', 9);
  await page.getByRole('button', { name: /关闭 .* 标签页/ }).last().click();
  await page.waitForFunction(() => document.querySelectorAll('.tabs [role=tab]').length === 9);
  await select('Meta+9', 8); await select('Meta+1', 0);
  await page.getByRole('option', { name: 'retained.txt', exact: true }).waitFor();

  const layouts = [['超大图标', 'icon-grid', 128], ['大图标', 'icon-grid', 64], ['中图标', 'icon-grid', 48], ['小图标', 'small-icons', 32], ['列表', 'file-list'], ['详细信息', 'file-table'], ['平铺', 'file-tiles'], ['内容', 'file-content-view']];
  for (const [index, [name, cls, size]] of layouts.entries()) {
    await page.keyboard.press(`Control+Shift+${index + 1}`);
    await page.locator(`.file-items.${cls}`).waitFor();
    if (size) await page.waitForFunction(size => document.querySelector('.file-items')?.style.getPropertyValue('--file-icon-size') === `${size}px`, size);
    await page.getByRole('button', { name: '查看', exact: true }).click();
    const item = page.getByRole('menuitemradio', { name, exact: true });
    assert.equal(await item.getAttribute('aria-checked'), 'true');
    assert.equal(await item.locator('kbd').innerText(), `⌃⇧${index + 1}`);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Meta+f');
  const search = page.getByRole('textbox', { name: '搜索文件', exact: true });
  await search.fill('keep draft'); await select('Meta+1', 0);
  assert.equal(await search.inputValue(), 'keep draft');
  await page.keyboard.press('Control+Shift+2'); await page.locator('.file-items.file-content-view').waitFor();
  await select('Meta+2', 1); assert.equal(await search.inputValue(), '');
  await page.keyboard.press('Control+l');
  const address = page.getByRole('textbox', { name: '文件夹地址', exact: true });
  await address.fill('unsubmitted path'); await select('Meta+3', 2);
  assert.equal(await address.count(), 0);
  await select('Meta+1', 0);
  await page.getByRole('option', { name: 'retained.txt', exact: true }).click();
  await page.keyboard.press('F2');
  const rename = page.getByRole('textbox', { name: '名称', exact: true });
  await rename.fill('unsaved.txt'); await page.keyboard.press('Meta+2');
  assert.equal(await activeIndex(), 0); assert.equal(await rename.inputValue(), 'unsaved.txt');
  await page.keyboard.press('Escape');

  await settings();
  await page.keyboard.press('Meta+2'); assert.equal(await activeIndex(), 0);
  assert.equal(await page.locator('.operation-shortcut').count(), 42);
  await page.getByRole('textbox', { name: '切换到第 1 个标签页的快捷键', exact: true }).press('Meta+Alt+1');
  await page.getByRole('textbox', { name: '内容视图的快捷键', exact: true }).press('Meta+Alt+8');
  await page.getByRole('button', { name: '保存操作快捷键', exact: true }).click();
  await page.waitForFunction(() => window.explorer.settings().then(s => s.operationShortcuts['tab-1']?.[0] === 'Command+Alt+1' && s.operationShortcuts.content?.[0] === 'Command+Alt+8'));
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/numbered-shortcuts-settings.png' });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await select('Meta+2', 1); await select('Meta+1', 1); await select('Meta+Alt+1', 0);
  await page.keyboard.press('Control+Shift+6'); await page.locator('.file-items.file-table').waitFor();
  await page.keyboard.press('Control+Shift+8'); assert.equal(await page.locator('.file-items.file-table').count(), 1);
  await page.keyboard.press('Meta+Alt+8'); await page.locator('.file-items.file-content-view').waitFor();
  await page.getByRole('button', { name: '查看', exact: true }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: '内容', exact: true }).locator('kbd').innerText(), '⌥⌘8');
  await page.keyboard.press('Escape');
  const saved = (await state()).operationShortcuts;
  await app.close(); await launch();
  assert.deepEqual((await state()).operationShortcuts, saved);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.app-data/shortcuts.json'), 'utf8')).operationShortcutsVersion, 2);

  // An old file has no version and may use newly assigned keys for other actions.
  await app.close();
  const legacy = { wakeShortcut: 'Command+9', operationShortcuts: { rename: ['Command+3'], refresh: ['Control+Shift+5'], copy: [], icons: ['Command+1'] } };
  const settingsFile = path.join(root, '.app-data/shortcuts.json');
  await fs.writeFile(settingsFile, JSON.stringify(legacy));
  await launch();
  const expected = { ...legacy.operationShortcuts, 'tab-1': [], 'tab-3': [], 'last-tab': [], list: [] };
  assert.deepEqual((await state()).operationShortcuts, expected);
  assert.equal((await state()).wakeShortcut, 'Command+9');
  assert.equal(await fs.readFile(settingsFile, 'utf8'), JSON.stringify(legacy));
  await page.getByRole('option', { name: 'retained.txt', exact: true }).click(); await page.keyboard.press('Meta+3');
  await page.getByRole('textbox', { name: '名称', exact: true }).waitFor(); await page.keyboard.press('Escape');
  await page.evaluate(expected => window.explorer.setOperationShortcuts(expected), expected);
  await app.close(); await launch();
  assert.deepEqual((await state()).operationShortcuts, expected);
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).operationShortcutsVersion, 2);
  await page.evaluate(async () => { await window.explorer.setWakeShortcut(''); await window.explorer.setOperationShortcuts({}); });
  assert.deepEqual((await state()).operationShortcuts, {});
  assert.equal(await fs.readFile(path.join(docs, 'retained.txt'), 'utf8'), 'Keep this content');
  assert.deepEqual(errors, []);
  console.log('PASS: numbered/missing/last tabs, 9+ tabs and close, existing tab cycling, eight exact layouts and menu hints, input/rename/modal guards, editable mappings, restart persistence and legacy custom/wake migration. Real Electron; temporary files only.');
} finally {
  await app?.close(); await fs.rm(root, { recursive: true, force: true });
}
