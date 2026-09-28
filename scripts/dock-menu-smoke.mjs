import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-dock-'));
await fs.mkdir(path.join(root, 'Documents'));
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
const click = label => app.evaluate(({ app }, label) => {
  const item = app.dock.getMenu().items.find(item => item.label === label);
  if (!item) throw new Error(`Missing Dock item: ${label}`);
  item.click();
}, label);
try {
  const first = await app.firstWindow();
  await first.getByRole('tab').waitFor();
  assert.deepEqual(await app.evaluate(({ app }) => app.dock.getMenu().items.map(item => item.label)), ['新建窗口', '新建标签页']);
  await click('新建标签页');
  await first.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  const opened = app.waitForEvent('window');
  await click('新建窗口');
  const second = await opened;
  await second.getByRole('option', { name: 'Documents', exact: true }).waitFor();
  assert.equal(await second.getByRole('tab').count(), 1);
  const secondWindow = await app.browserWindow(second);
  await secondWindow.evaluate(window => { window.show(); window.focus(); window.emit('focus'); window.minimize(); });
  const before = await Promise.all([first.getByRole('tab').count(), second.getByRole('tab').count()]);
  await click('新建标签页');
  await second.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.equal(await first.getByRole('tab').count(), before[0]);
  assert.equal(await secondWindow.evaluate(window => window.isMinimized()), false);
  await second.evaluate(() => window.explorer.setLanguage('en'));
  assert.deepEqual(await app.evaluate(({ app }) => app.dock.getMenu().items.map(item => item.label)), ['New window', 'New tab']);
  const reopened = app.waitForEvent('window');
  await app.evaluate(({ app, BrowserWindow }) => {
    app.removeAllListeners('window-all-closed'); app.on('window-all-closed', () => {});
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    if (BrowserWindow.getAllWindows().length) throw new Error('Expected no windows');
    app.dock.getMenu().items.find(item => item.label === 'New tab').click();
  });
  const last = await reopened;
  await last.getByRole('tab').waitFor();
  assert.equal(await last.getByRole('tab').count(), 1);
  console.log('PASS: native Dock actions, separate home window, existing-window tab routing, language switching and reopening with no windows.');
} finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
