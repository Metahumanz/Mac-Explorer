import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-language-'));
await fs.mkdir(path.join(root, 'Documents')); await fs.mkdir(path.join(root, '.Trash'));
await fs.writeFile(path.join(root, 'Documents', '中文文件 English.txt'), 'unchanged');
const env = { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1', EXPLORER_TEST_LOCALE: 'zh-HK' };
let app;
try {
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env });
  let page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const row = () => page.getByRole('option', { name: '中文文件 English.txt', exact: true });
  await row().waitFor();
  async function openSettings() {
    const locale = await page.evaluate(() => document.documentElement.lang);
    const more = locale === 'en' ? 'More' : '更多';
    const settings = locale === 'en' ? 'Settings…' : locale === 'zh-TW' ? '設定…' : '设置…';
    await page.getByRole('button', { name: more, exact: true }).click();
    await page.getByRole('menuitem', { name: settings, exact: true }).click();
    await page.getByRole('combobox').waitFor();
  }
  async function language(choice) {
    await openSettings();
    await page.getByRole('combobox').selectOption({ label: choice });
    await page.waitForFunction(() => !document.querySelector('.settings-language select').disabled);
    await page.getByRole('dialog').locator('.modal-heading > button').click();
  }
  await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
  assert.deepEqual(await page.evaluate(async () => (await window.explorer.bootstrap()).language), { mode: 'system', locale: 'zh-TW' });
  await openSettings();
  assert.equal(await page.getByRole('combobox').inputValue(), 'system');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await row().click();
  await language('English');
  await page.getByRole('button', { name: 'More', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await row().waitFor();
  assert.equal(await row().getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.sidebar').getByRole('button', { name: 'Documents', exact: true }).count(), 1);
  assert.ok((await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label))).includes('File'));
  await page.keyboard.press('Enter'); await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Move to Recycle Bin (⌘⌫)', exact: true }).click();
  await page.getByRole('dialog').getByText('Move “中文文件 English.txt” to the Recycle Bin?', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openSettings();
  assert.equal(await page.getByRole('combobox').inputValue(), 'en');
  await page.screenshot({ path: 'artifacts/language-english-fixture.png' });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await app.close();
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env }); page = await app.firstWindow();
  await page.getByRole('button', { name: 'More', exact: true }).waitFor();
  await language('繁體中文');
  await page.getByRole('button', { name: '更多', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
  await page.locator('.sidebar').getByRole('button', { name: '資源回收筒', exact: true }).waitFor();
  assert.ok((await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label))).includes('檔案'));
  await language('简体中文');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await language('跟随系统');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
  await openSettings();
  assert.equal(await page.getByRole('combobox').inputValue(), 'system');
  await page.evaluate(() => window.explorer.setTheme('dark'));
  await page.screenshot({ path: 'artifacts/language-traditional-fixture.png' });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // Simulate an OS preferred-language change when the window regains focus.
  await app.evaluate(({ BrowserWindow }) => { process.env.EXPLORER_TEST_LOCALE = 'en-US'; BrowserWindow.getAllWindows()[0].emit('focus'); });
  await page.getByRole('button', { name: 'More', exact: true }).waitFor();
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.app-data', 'language.json'), 'utf8')).mode, 'system');
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('list-trash'); ipcMain.handle('list-trash', () => ({ entries: [], roots: [], unavailable: ['fixture'] })); });
  await page.locator('.sidebar').getByRole('button', { name: 'Recycle Bin', exact: true }).click();
  await page.getByRole('button', { name: 'Open Settings', exact: true }).waitFor();
  const invalid = await page.evaluate(async () => { try { await window.explorer.setLanguage('invalid'); return ''; } catch (error) { return String(error); } });
  assert.match(invalid, /Invalid language setting/);
  assert.equal(await fs.readFile(path.join(root, 'Documents', '中文文件 English.txt'), 'utf8'), 'unchanged');
  console.log('PASS: first launch follows the system, all four Settings language choices, manual preference survives restart, native menus, follow-system refresh, dialogs, permission CTA, selection and filename preservation.');
} finally { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); }
