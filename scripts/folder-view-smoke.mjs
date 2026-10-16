import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-folder-view-'));
const docs = path.join(root, 'Documents'); const folderA = path.join(docs, 'A'); const folderB = path.join(docs, 'B');
for (const folder of [folderA, folderB, path.join(root, 'Desktop'), path.join(root, 'Downloads')]) await fs.mkdir(folder, { recursive: true });
// Name order and modified order disagree, so the visible order reveals the sort.
for (const folder of [folderA, folderB]) {
  await fs.writeFile(path.join(folder, 'a-new.txt'), 'new');
  await fs.writeFile(path.join(folder, 'b-old.txt'), 'old');
  await fs.utimes(path.join(folder, 'b-old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
}
const store = path.join(root, '.app-data', 'folder-views.json');
const launch = () => electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
let app = await launch();
let page;
try {
  const at = name => page.locator(`.file-content[aria-label="${name}"][aria-busy="false"]`).waitFor();
  const open = async () => { page = await app.firstWindow(); page.setDefaultTimeout(15000); await at('文档'); };
  const enter = async name => { await page.getByRole('option', { name, exact: true }).dblclick(); await at(name); };
  const back = async name => { await page.keyboard.press('Meta+['); await at(name); };
  const layout = cls => page.locator(`.file-items.${cls}`).waitFor();
  const menu = async (button, name, role) => { await page.getByRole('button', { name: button, exact: true }).click(); await page.getByRole(role, { name, exact: true }).click(); };
  // The label can switch before the old listing is replaced; wait for this folder's files.
  const sortedByModified = async () => {
    await page.getByRole('option', { name: 'b-old.txt', exact: true }).waitFor();
    const names = await page.locator('.file-row').evaluateAll(rows => rows.map(row => row.textContent));
    return names.findIndex(name => name.includes('b-old')) < names.findIndex(name => name.includes('a-new'));
  };
  const settings = async action => {
    await menu('更多', '设置…', 'menuitem');
    const dialog = page.getByRole('dialog', { name: '设置', exact: true }); await dialog.waitFor();
    await action(dialog);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  };
  const stored = async () => JSON.parse(await fs.readFile(store, 'utf8'));
  await open();
  await layout('icon-grid');
  await menu('查看', '详细信息', 'menuitemradio'); await layout('file-table');
  await enter('A'); await layout('icon-grid'); // Unchanged folders follow the defaults.
  assert.equal(await sortedByModified(), false);
  await menu('排序', '修改日期', 'menuitemcheckbox');
  assert.equal(await sortedByModified(), true);
  await back('文档'); await layout('file-table');
  await enter('B'); await layout('icon-grid'); assert.equal(await sortedByModified(), false);

  // New defaults reach folders without overrides, and only the groups a folder did not override.
  await settings(async dialog => {
    await dialog.getByLabel('默认布局', { exact: true }).selectOption('list');
    await dialog.getByLabel('排序方向', { exact: true }).selectOption('descending');
  });
  await layout('file-list'); assert.equal(await sortedByModified(), true); // B: descending by name puts b-old first.
  await back('文档'); await layout('file-table');
  await enter('A'); await layout('file-list'); assert.equal(await sortedByModified(), true);
  // A group set back to the defaults follows them again; an empty override is removed.
  await menu('排序', '名称', 'menuitemcheckbox'); await menu('排序', '递减', 'menuitemcheckbox');
  for (let i = 0; i < 50 && (await stored()).folders.some(([location]) => location === folderA); i++) await page.waitForTimeout(50);
  assert.deepEqual((await stored()).folders.map(([location]) => location), [docs]);

  await app.close();
  app = await launch(); await open(); // Defaults and overrides survive a restart.
  await layout('file-table');
  await enter('B'); await layout('file-list');
  // Applying a folder's settings to all folders makes them the defaults and clears overrides.
  await back('文档'); await menu('查看', '应用到所有文件夹', 'menuitem');
  await enter('A'); await layout('file-table'); assert.equal(await sortedByModified(), true); // Descending by name.
  assert.deepEqual(await stored(), { defaults: { view: 'details', iconSize: 64, sort: 'name', ascending: false }, folders: [] });
  // Reset all folders from Settings.
  await menu('查看', '平铺', 'menuitemradio'); await layout('file-tiles');
  await settings(async dialog => {
    await dialog.getByRole('button', { name: '重置所有文件夹', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '已重置' }).waitFor();
  });
  await layout('file-table');
  // Earlier versions kept layouts in localStorage; they are imported once and removed.
  await page.evaluate(location => localStorage.setItem('directoryViews', JSON.stringify({ [location]: { view: 'content', iconSize: 64 } })), folderB);
  await page.reload(); await at('文档');
  await enter('B'); await layout('file-content-view');
  assert.equal(await page.evaluate(() => localStorage.getItem('directoryViews')), null);
  console.log('PASS: per-folder layout and sort, defaults from Settings, partial overrides, reverting to defaults, restart persistence, apply to all folders, reset, legacy import.');
} finally {
  await app.close(); await fs.rm(root, { recursive: true, force: true });
}
