import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-new-entry-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(docs);
const labels = ['文件夹', '文本文档', 'Word 文档', 'Excel 工作簿', 'PowerPoint 演示文稿'];
const names = ['新建文件夹', '新建文本文档.txt', '新建 Word 文档.docx', '新建 Excel 工作簿.xlsx', '新建 PowerPoint 演示文稿.pptx'];
let app;
try {
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-content[aria-busy=false]').waitFor();
  const openNew = async (keyboard = false) => {
    const content = page.locator('.file-content');
    const box = await content.boundingBox();
    await content.click({ button: 'right', position: { x: box.width - 25, y: box.height - 25 } });
    const item = page.getByRole('menuitem', { name: '新建', exact: true });
    if (keyboard) { await item.focus(); await item.press('ArrowRight'); }
    else await item.hover();
    await page.locator('.context-submenu').waitFor();
    assert.deepEqual(await page.locator('.context-submenu button').allTextContents().then(items => items.map(text => text.replace('⇧⌘N', '').trim())), labels);
  };
  for (let i = 0; i < labels.length; i += 1) {
    await openNew(i === 0);
    if (i === 0) {
      await fs.mkdir('artifacts', { recursive: true });
      await page.locator('.context-menu').evaluateAll(menus => Promise.all(menus.flatMap(menu => menu.getAnimations().map(animation => animation.finished))));
      await page.screenshot({ path: 'artifacts/new-entry-menu-fixture.png' });
      assert.equal(await page.locator('.context-menu').evaluateAll(menus => menus.every(menu => { const r = menu.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })), true);
    }
    await page.locator('.context-submenu').getByRole('menuitem').nth(i).click();
    const input = page.getByLabel('名称', { exact: true });
    await input.waitFor();
    assert.equal(await input.inputValue(), names[i]);
    await input.press('Enter');
    await page.getByRole('option', { name: names[i], exact: true }).waitFor();
    const file = path.join(docs, names[i]);
    if (i === 0) assert.equal((await fs.stat(file)).isDirectory(), true);
    else if (i === 1) assert.equal(await fs.readFile(file, 'utf8'), '');
    else execFileSync('/usr/bin/unzip', ['-t', file]);
  }
  // Creating the same type again numbers the filename and leaves the first document intact.
  const original = await fs.readFile(path.join(docs, names[2]));
  await openNew();
  await page.getByRole('menuitem', { name: labels[2], exact: true }).click();
  assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '新建 Word 文档 (2).docx');
  await page.getByLabel('名称', { exact: true }).fill('重命名.docx');
  await page.getByLabel('名称', { exact: true }).press('Enter');
  await page.getByRole('option', { name: '重命名.docx', exact: true }).waitFor();
  await page.locator('.file-content').press('Meta+z');
  await page.getByRole('option', { name: '重命名.docx', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('option', { name: '新建 Word 文档 (2).docx', exact: true }).waitFor();
  await page.locator('.file-content').press('Meta+z');
  await page.getByRole('option', { name: '新建 Word 文档 (2).docx', exact: true }).waitFor({ state: 'detached' });
  await assert.rejects(fs.access(path.join(docs, '新建 Word 文档 (2).docx')));
  assert.deepEqual(await fs.readFile(path.join(docs, names[2])), original);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents().then(items => items.map(text => text.replace('⇧⌘N', '').trim())), labels);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '此电脑', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '新建', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: ordered New menus; all five types; valid Office ZIPs; inline rename; duplicate numbering; undo; keyboard submenu; viewport bounds; virtual-location guard.');
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
