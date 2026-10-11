import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-move-'));
await fs.mkdir(path.join(root, 'Documents/target'), { recursive: true });
await fs.mkdir(path.join(root, 'Desktop'));
for (const name of ['move.txt', 'collision.txt']) await fs.writeFile(path.join(root, 'Documents', name), 'source');
await fs.writeFile(path.join(root, 'Documents/target/collision.txt'), 'destination');
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const row = name => page.getByRole('option', { name, exact: true });
  await row('move.txt').waitFor();
  await row('move.txt').dragTo(row('target'));
  await row('move.txt').waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(path.join(root, 'Documents/target/move.txt'), 'utf8'), 'source');
  await page.evaluate(() => window.explorer.undo());
  await row('move.txt').waitFor();
  async function dropFile(input, target) {
    const data = await page.evaluateHandle(input => { const data = new DataTransfer(); data.setData('application/x-explorer-paths', JSON.stringify([input])); return data; }, input);
    await target.dispatchEvent('drop', { dataTransfer: data });
    await data.dispose();
  }
  const collision = await page.evaluate(root => window.explorer.moveTo([root + '/Documents/collision.txt'], root + '/Documents/target'), root);
  assert.equal(collision.errors.length, 1);
  assert.equal(await fs.readFile(path.join(root, 'Documents/collision.txt'), 'utf8'), 'source');
  assert.equal(await fs.readFile(path.join(root, 'Documents/target/collision.txt'), 'utf8'), 'destination');
  await dropFile(path.join(root, 'Documents/move.txt'), page.getByRole('button', { name: '桌面', exact: true }));
  await row('move.txt').waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(path.join(root, 'Desktop/move.txt'), 'utf8'), 'source');
  const transfer = await page.evaluateHandle(input => { const data = new DataTransfer(); data.setData('application/x-explorer-paths', JSON.stringify([input])); return data; }, path.join(root, 'Desktop/move.txt'));
  await page.locator('.file-content').dispatchEvent('drop', { dataTransfer: transfer });
  await row('move.txt').waitFor();
  await assert.rejects(fs.access(path.join(root, 'Desktop/move.txt')));
  const opened = app.waitForEvent('window');
  await app.evaluate(({ app }) => app.dock.getMenu().items.find(item => item.label === '新建窗口').click());
  const second = await opened; await second.getByRole('tab').waitFor();
  const closed = second.waitForEvent('close');
  await second.locator('.tab-close').click(); await closed;
  assert.equal(page.isClosed(), false);
  await page.getByRole('button', { name: '新建标签页 (⌘T)', exact: true }).click();
  assert.equal(await page.getByRole('tab').count(), 2);
  // Hover an inactive tab during a drag: it should switch to that tab, and dropping onto
  // another tab moves the file into that tab's folder.
  await page.getByRole('button', { name: '桌面', exact: true }).click();
  const docsTab = page.getByRole('tab', { name: '文档', exact: true });
  const desktopTab = page.getByRole('tab', { name: '桌面', exact: true });
  const hover = await page.evaluateHandle(() => new DataTransfer());
  await docsTab.dispatchEvent('dragover', { dataTransfer: hover });
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === '文档', undefined, { timeout: 5000 });
  const tabTransfer = await page.evaluateHandle(input => { const data = new DataTransfer(); data.setData('application/x-explorer-paths', JSON.stringify([input])); return data; }, path.join(root, 'Documents/move.txt'));
  await desktopTab.dispatchEvent('drop', { dataTransfer: tabTransfer });
  await row('move.txt').waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(path.join(root, 'Desktop/move.txt'), 'utf8'), 'source');
  await assert.rejects(fs.access(path.join(root, 'Documents/move.txt')));
  console.log('PASS: row/sidebar/background/tab drops move, hover switches tabs, undo restores, collisions preserve both files, closing last tab closes only its window.');
} finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
