import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-pr17-review-'));
const docs = path.join(root, 'Documents');
const cold = path.join(docs, 'Cold');
const store = path.join(root, '.app-data', 'folder-views.json');
const defaults = { view: 'icons', iconSize: 64, sort: 'name', ascending: true };
const details = { layout: { view: 'details', iconSize: 64 } };
for (const directory of [docs, cold, path.dirname(store)]) await fs.mkdir(directory, { recursive: true });
for (const directory of [docs, cold]) {
  await fs.writeFile(path.join(directory, 'a-new.txt'), 'new');
  await fs.writeFile(path.join(directory, 'b-old.txt'), 'old');
  await fs.utimes(path.join(directory, 'b-old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
}
await fs.writeFile(store, JSON.stringify({ defaults, folders: [[cold, details], ...Array.from({ length: 4999 }, (_, index) => [`review-slot-${index}`, details])] }));
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
const results = [];
const disk = async () => JSON.parse(await fs.readFile(store, 'utf8'));
const at = async (page, name) => {
  await page.locator(`.file-content[aria-label="${name}"][aria-busy="false"]`).waitFor();
  await page.getByRole('option', { name: 'a-new.txt', exact: true }).waitFor();
};
const go = async (page, directory, name) => {
  await page.keyboard.press('Control+l');
  const address = page.getByRole('textbox', { name: '文件夹地址', exact: true });
  await address.fill(directory); await address.press('Enter'); await at(page, name);
};
const snapshot = page => page.locator('.file-items').evaluate(element => ({
  layout: element.classList.contains('file-table') ? 'details' : element.classList.contains('icon-grid') ? 'icons' : element.className,
  order: [...element.querySelectorAll('.file-row')].map(row => row.getAttribute('data-path').split('/').at(-1)).filter(name => name.endsWith('.txt')),
}));
const chooseSort = async (page, name) => {
  await page.getByRole('button', { name: '排序', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name, exact: true }).click();
};
try {
  const first = await app.firstWindow(); first.setDefaultTimeout(10000); await at(first, '文档');
  // The default 5000-entry limit is exercised without creating 5000 real folders.
  await first.getByRole('button', { name: '详细信息视图', exact: true }).click();
  await first.waitForFunction(async location => !(location in (await window.explorer.bootstrap()).folderViews.overrides), cold);
  await go(first, cold, 'Cold');
  const stale = await snapshot(first);
  assert.equal(stale.layout, 'icons');
  assert.equal((await disk()).folders.some(([location]) => location === cold), false);
  await first.reload(); await at(first, '文档'); await go(first, cold, 'Cold');
  const fresh = await snapshot(first); assert.equal(fresh.layout, 'icons');
  results.push({ case: 'LRU eviction immediately reaches the renderer', expected: 'Evicted folder uses defaults immediately', beforeReload: stale, afterReload: fresh });

  await first.evaluate(value => window.explorer.resetFolderViews(value), defaults);
  await go(first, docs, '文档');
  await chooseSort(first, '修改日期');
  await first.waitForFunction(async location => (await window.explorer.bootstrap()).folderViews.overrides[location]?.sort?.sort === 'modified', docs);
  await first.evaluate(value => window.explorer.setFolderViewDefaults(value), { ...defaults, sort: 'modified' });
  const beforeOtherGroup = (await first.evaluate(() => window.explorer.bootstrap())).folderViews.overrides[docs];
  assert.equal(beforeOtherGroup.sort.sort, 'modified');
  await first.getByRole('button', { name: '详细信息视图', exact: true }).click();
  await first.waitForFunction(async location => (await window.explorer.bootstrap()).folderViews.overrides[location]?.layout?.view === 'details', docs);
  const afterOtherGroup = (await first.evaluate(() => window.explorer.bootstrap())).folderViews.overrides[docs];
  assert.deepEqual(afterOtherGroup.sort, { sort: 'modified', ascending: true });
  await first.evaluate(value => window.explorer.setFolderViewDefaults(value), defaults);
  await first.waitForFunction(() => [...document.querySelectorAll('.file-row')].filter(row => row.getAttribute('data-path').endsWith('.txt'))[0]?.getAttribute('data-path').endsWith('b-old.txt'));
  results.push({ case: 'Layout-only changes keep untouched sort overrides', expected: 'Modified-date override survives a layout-only change', beforeOtherGroup, afterOtherGroup, actual: await snapshot(first) });

  await first.evaluate(value => window.explorer.resetFolderViews(value), defaults);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ app }) => app.dock.getMenu().items.find(item => item.label === '新建窗口').click());
  const second = await opened; second.setDefaultTimeout(10000); await second.getByRole('tab').waitFor(); await go(second, docs, '文档');
  await first.locator('.file-items.icon-grid').waitFor(); await second.locator('.file-items.icon-grid').waitFor();
  // Hold one real temporary-settings write to reproduce overlapping window edits deterministically.
  await app.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    const files = require('node:fs/promises'); const original = files.writeFile;
    globalThis.folderWriteCount = 0;
    files.writeFile = async function (...args) {
      if (String(args[0]).endsWith('folder-views.json.tmp')) {
        globalThis.folderWriteCount++;
        if (globalThis.folderWriteCount === 1) {
          globalThis.folderWriteBlocked = true;
          await new Promise(resolve => { globalThis.releaseFolderWrite = resolve; });
        }
      }
      return original.apply(this, args);
    };
  });
  await second.getByRole('button', { name: '排序', exact: true }).click();
  await first.getByRole('button', { name: '详细信息视图', exact: true }).click();
  for (let index = 0; index < 100 && !await app.evaluate(() => globalThis.folderWriteBlocked); index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await app.evaluate(() => globalThis.folderWriteBlocked), true);
  await second.getByRole('menuitemcheckbox', { name: '修改日期', exact: true }).click();
  await second.waitForFunction(async location => (await window.explorer.bootstrap()).folderViews.overrides[location]?.sort?.sort === 'modified', docs);
  await app.evaluate(() => globalThis.releaseFolderWrite());
  await first.locator('.file-items.file-table').waitFor(); await second.locator('.file-items.file-table').waitFor();
  await second.waitForFunction(() => [...document.querySelectorAll('.file-row')].filter(row => row.getAttribute('data-path').endsWith('.txt'))[0]?.getAttribute('data-path').endsWith('b-old.txt'));
  await first.waitForFunction(() => [...document.querySelectorAll('.file-row')].filter(row => row.getAttribute('data-path').endsWith('.txt'))[0]?.getAttribute('data-path').endsWith('b-old.txt'));
  const firstState = await snapshot(first); const secondState = await snapshot(second);
  const saved = Object.fromEntries((await disk()).folders)[docs];
  assert.deepEqual(saved, { layout: { view: 'details', iconSize: 64 }, sort: { sort: 'modified', ascending: true } });
  assert.equal(firstState.layout, 'details'); assert.equal(secondState.layout, 'details');
  assert.deepEqual(firstState.order, ['b-old.txt', 'a-new.txt']);
  assert.deepEqual(secondState.order, ['b-old.txt', 'a-new.txt']);
  results.push({ case: 'Overlapping window edits retain both groups and converge', expected: 'Both windows and disk retain layout=details and sort=modified', slowWriteInjected: true, first: firstState, second: secondState, saved });
  await fs.mkdir('artifacts/folder-view', { recursive: true });
  await fs.writeFile('artifacts/folder-view/sync-results.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  console.log('PASS: untouched overrides, 5000-entry eviction, and overlapping two-window edits remain consistent.');
} finally {
  await app.evaluate(() => globalThis.releaseFolderWrite?.()).catch(() => {});
  await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
