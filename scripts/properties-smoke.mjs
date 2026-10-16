import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-properties-ui-')));
const docs = path.join(root, 'Documents');
const folder = path.join(docs, '项目资料');
await fs.mkdir(path.join(folder, '子目录'), { recursive: true });
await fs.mkdir(path.join(folder, 'empty'));
await fs.writeFile(path.join(folder, 'one.txt'), '12345');
await fs.writeFile(path.join(folder, '子目录/中文 #%.txt'), '123');
await fs.writeFile(path.join(folder, '.hidden'), '1234');
await fs.writeFile(path.join(docs, 'README.txt'), 'readme');
await fs.symlink(folder, path.join(docs, '项目链接'));
await fs.mkdir('artifacts/properties', { recursive: true });
let app;
try {
  app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-content[aria-busy="false"]').waitFor();
  const row = name => page.getByRole('option', { name, exact: true });
  const open = async (name, label = '属性') => {
    await row(name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.locator('.properties-storage[aria-busy="false"]').waitFor();
    await page.getByRole('dialog').evaluate(dialog => Promise.all(dialog.getAnimations().map(animation => animation.finished)));
  };
  await open('项目资料');
  assert.equal(await page.locator('.details-pane').count(), 0, 'Properties must not toggle the details pane');
  assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(), '项目资料');
  assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).getAttribute('readonly'), '');
  assert.match(await page.locator('.properties-storage').innerText(), /3 个文件，2 个文件夹/);
  const stats = await page.evaluate(folder => window.explorer.properties([folder], 'smoke-summary'), folder);
  assert.equal(stats.size, 12); assert.equal(stats.files, 3); assert.equal(stats.folders, 2); assert.equal(stats.skipped, 0);
  const handle = page.getByRole('group', { name: '拖动或使用方向键移动属性窗口', exact: true });
  const bounds = () => page.getByRole('dialog').evaluate(dialog => { const r = dialog.getBoundingClientRect(); return { left: r.left, top: r.top }; });
  const contained = () => page.getByRole('dialog').evaluate(dialog => { const r = dialog.getBoundingClientRect(); return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11; });
  const dragBy = async (dx, dy) => {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 80, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 80 + dx, box.y + box.height / 2 + dy, { steps: 8 }); await page.mouse.up();
  };
  const initial = await bounds();
  await dragBy(70, 20);
  const moved = await bounds();
  assert.ok(Math.abs(moved.left - initial.left - 70) < 2); assert.ok(Math.abs(moved.top - initial.top - 20) < 2);
  await handle.focus(); await handle.press('ArrowLeft');
  assert.ok(Math.abs((await bounds()).left - moved.left + 10) < 2);
  await dragBy(-3000, -3000); assert.ok(await contained());
  assert.ok((await bounds()).left <= 13); assert.ok((await bounds()).top <= 13);
  await dragBy(3000, 3000); assert.ok(await contained());
  const released = await bounds(); await page.mouse.move(100, 100); assert.deepEqual(await bounds(), released);
  const title = await handle.boundingBox();
  await page.mouse.move(title.x + 80, title.y + title.height / 2); await page.mouse.down();
  await handle.evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  const cancelled = await bounds(); await page.mouse.move(250, 100); await page.mouse.up(); assert.deepEqual(await bounds(), cancelled);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 600));
  await page.waitForFunction(() => { const r = document.querySelector('dialog').getBoundingClientRect(); return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11; });
  await page.getByRole('button', { name: '关闭属性', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 820));
  await open('项目资料');
  assert.equal(await page.getByRole('dialog').evaluate(dialog => dialog.style.left), '', 'Reopening recenters the dialog');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.explorer.setTheme(theme), theme);
    await page.waitForFunction(dark => matchMedia('(prefers-color-scheme: dark)').matches === dark, theme === 'dark');
    await page.screenshot({ path: `artifacts/properties/folder-${theme}-fixture.png`, animations: 'disabled' });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 600));
  assert.ok(await page.getByRole('dialog').evaluate(dialog => { const rect = dialog.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth; }));
  await page.getByRole('button', { name: '确定', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: 'artifacts/properties/compact-fixture.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  await open('README.txt');
  assert.equal(await page.locator('.properties-fields dt').filter({ hasText: /^包含$/ }).count(), 0);
  assert.match(await page.locator('.properties-storage').innerText(), /6/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await row('项目资料').click(); await row('README.txt').click({ modifiers: ['Meta'] });
  await open('项目资料');
  assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(), '2 个项目');
  assert.match(await page.locator('.properties-storage').innerText(), /4 个文件，2 个文件夹/);
  await page.getByRole('button', { name: '关闭属性', exact: true }).click();
  await row('项目链接').click(); await open('项目链接');
  assert.equal(await page.getByText('符号链接按链接本身统计，不包含目标内容。', { exact: true }).count(), 0);
  assert.match(await page.locator('.properties-storage').innerText(), /1 个文件，0 个文件夹/);
  await page.getByRole('button', { name: '确定', exact: true }).click();

  // Delay real metadata reads in the fixture tree so closing can interrupt a live scan.
  await app.evaluate(({}, folder) => {
    const disk = process.getBuiltinModule('fs/promises');
    globalThis.originalPropertiesStat = disk.lstat;
    disk.lstat = async (...args) => { if (String(args[0]).startsWith(folder + '/')) await new Promise(resolve => setTimeout(resolve, 30)); return globalThis.originalPropertiesStat(...args); };
  }, folder);
  await row('项目资料').click(); await row('项目资料').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '属性', exact: true }).click();
  await page.locator('.properties-storage[aria-busy="true"]').waitFor();
  await page.keyboard.press('Escape');
  await open('README.txt');
  assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(), 'README.txt');
  assert.match(await page.locator('.properties-storage').innerText(), /6/);
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await app.evaluate(() => { process.getBuiltinModule('fs/promises').lstat = globalThis.originalPropertiesStat; });

  await app.evaluate(({}, folder) => {
    process.getBuiltinModule('fs/promises').lstat = async (...args) => {
      if (args[0] === folder) throw Object.assign(new Error('Fixture removed'), { code: 'ENOENT' });
      return globalThis.originalPropertiesStat(...args);
    };
  }, folder);
  await open('项目资料');
  await page.getByRole('alert').filter({ hasText: '已不存在' }).waitFor();
  assert.match(await page.locator('.properties-storage').innerText(), /不可用/);
  await page.keyboard.press('Escape');
  await app.evaluate(() => { process.getBuiltinModule('fs/promises').lstat = globalThis.originalPropertiesStat; });

  await page.getByRole('button', { name: '查看', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '详细信息窗格', exact: true }).click();
  await page.locator('.details-pane').waitFor();
  await open('README.txt');
  assert.equal(await page.locator('.details-pane').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '关闭详细信息', exact: true }).click();

  await assert.rejects(page.evaluate(() => window.explorer.properties(['relative'], 'invalid')), /绝对路径/);
  await assert.rejects(page.evaluate(() => window.explorer.properties([], 'invalid')), /文件选择/);
  await assert.rejects(page.evaluate(folder => window.explorer.properties([folder], ''), folder), /文件选择/);
  await assert.rejects(page.evaluate(root => window.explorer.properties([root + '/missing'], 'missing'), root), /不存在/);
  for (const [locale, label, nameLabel, contains] of [['en', 'Properties', 'Name', '3 files, 2 folders'], ['zh-TW', '內容', '名稱', '3 個檔案，2 個資料夾']]) {
    await page.evaluate(locale => window.explorer.setLanguage(locale), locale);
    await row('项目资料').click(); await open('项目资料', label);
    assert.equal(await page.getByRole('textbox', { name: nameLabel, exact: true }).inputValue(), '项目资料');
    assert.ok((await page.locator('.properties-storage').innerText()).includes(contains));
    await page.keyboard.press('Escape');
  }
  assert.equal(await fs.readFile(path.join(folder, 'one.txt'), 'utf8'), '12345');
  assert.equal(await fs.readFile(path.join(folder, '.hidden'), 'utf8'), '1234');
  assert.deepEqual(errors, []);
  console.log('PASS: Properties mouse/keyboard movement, four-edge clamping, release/cancel, viewport shrink and reopen centering; context menu, folder totals, single/multiple/symlink, close/reopen/cancel, invalid IPC, source preservation, light/dark/compact and three languages. Temporary fixtures only.');
} finally {
  if (app) await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
