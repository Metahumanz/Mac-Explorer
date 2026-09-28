import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-tabs-'));
await fs.mkdir(path.join(root, 'Documents/child'), { recursive: true });
await fs.writeFile(path.join(root, 'Documents/child/retained.txt'), 'keep');
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
  const page = await app.firstWindow();
  await page.getByRole('option', { name: 'child', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建标签页 (⌘T)', exact: true }).click();
  await page.getByRole('option', { name: 'Documents', exact: true }).dblclick();
  await page.getByRole('option', { name: 'child', exact: true }).dblclick();
  await page.getByRole('option', { name: 'retained.txt', exact: true }).waitFor();
  async function drag(tab, dy, release = true) {
    const box = await tab.boundingBox();
    await page.mouse.move(box.x + 50, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + 55, box.y + 15 + dy, { steps: 8 });
    if (release) await page.mouse.up();
  }
  await drag(page.getByRole('tab').nth(1), 8);
  assert.equal(app.windows().length, 1);
  const opened = app.waitForEvent('window');
  await drag(page.getByRole('tab').nth(1), 110, false);
  const detached = await opened;
  await detached.getByRole('option', { name: 'retained.txt', exact: true }).waitFor();
  assert.equal(app.windows().length, 2); // New window exists while the mouse is still held.
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1);
  await detached.getByRole('button', { name: '后退 (⌘[)', exact: true }).click();
  await detached.getByRole('option', { name: 'child', exact: true }).waitFor();
  await detached.getByRole('button', { name: '前进 (⌘])', exact: true }).click();
  await detached.getByRole('option', { name: 'retained.txt', exact: true }).waitFor();
  await fs.writeFile(path.join(root, 'Documents/original-watch.txt'), 'keep');
  await fs.writeFile(path.join(root, 'Documents/child/detached-watch.txt'), 'keep');
  await Promise.all([page.getByRole('option', { name: 'original-watch.txt', exact: true }).waitFor(), detached.getByRole('option', { name: 'detached-watch.txt', exact: true }).waitFor()]);
  assert.equal(await page.evaluate(async () => { try { await window.explorer.detachTab({ location: '/tmp', history: ['/tmp'], index: 8 }, { x: 100, y: 100 }, false); return false; } catch { return true; } }), true);
  await drag(page.getByRole('tab'), 100); // Last tab moves its existing window.
  assert.equal(app.windows().length, 2);
  await detached.close();
  await page.getByRole('button', { name: '新建标签页 (⌘T)', exact: true }).click();
  assert.equal(await page.getByRole('tab').count(), 2);
  const upward = app.waitForEvent('window');
  await drag(page.getByRole('tab').nth(1), -90, false);
  const above = await upward;
  await above.getByRole('tab').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1);
  await above.close();
  await page.getByRole('button', { name: '新建标签页 (⌘T)', exact: true }).click();
  await app.evaluate(({ app }) => app.once('browser-window-created', (_event, window) => process.nextTick(() => window.destroy())));
  await drag(page.getByRole('tab').nth(1), 110);
  await page.waitForFunction(() => document.body.textContent.includes('新窗口已关闭'));
  assert.equal(await page.getByRole('tab').count(), 2); // Failed transfer keeps source.
  console.log('PASS: drag threshold, detach, preserved history, independent watchers, invalid IPC, last-tab movement and remaining-window usability. Temporary fixtures only.');
} finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
