import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-windowstate-'));
await fs.mkdir(path.join(root, 'Documents'));
await fs.writeFile(path.join(root, 'Documents', '使用说明.txt'), '窗口位置测试 fixture。\n移动、缩放、重新打开。');
const preference = path.join(root, '.app-data', 'window-state.json');
let app, page;
const errors = [];
const waitFor = async (expected) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const saved = JSON.parse(await fs.readFile(preference, 'utf8'));
      if (['x', 'y', 'width', 'height'].every(key => Math.abs(saved[key] - expected[key]) <= 2)) return saved;
    } catch { /* Writes are atomic, so the file may not exist yet. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`窗口位置没有保存：${JSON.stringify(expected)}`);
};
const launch = async () => {
  app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root } });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('option', { name: '使用说明.txt', exact: true }).waitFor();
};
const quit = async () => { await app.close(); await new Promise(resolve => setTimeout(resolve, 300)); };
// Keep the request inside the display the window already occupies, and report what macOS
// actually applied: window managers clamp positions instead of honoring them exactly.
const place = async (offset) => app.evaluate(({ BrowserWindow, screen }, offset) => {
  const owner = BrowserWindow.getAllWindows()[0];
  const area = screen.getDisplayMatching(owner.getBounds()).workArea;
  const width = Math.min(1000, area.width - 200);
  const height = Math.min(700, area.height - 160);
  owner.setBounds({ x: area.x + 80 + offset, y: area.y + 60 + offset / 2, width: width - offset, height: height - offset });
  const { x, y, width: w, height: h } = owner.getBounds();
  return { x, y, width: w, height: h };
}, offset);
const current = async () => app.evaluate(({ BrowserWindow }) => {
  const { x, y, width, height } = BrowserWindow.getAllWindows()[0].getBounds();
  return { x, y, width, height };
});
try {
  await launch();
  const moved = await place(0);
  await waitFor(moved);
  const resized = await place(60);
  const saved = await waitFor(resized);
  assert.notEqual(resized.width, moved.width, '尺寸应当发生变化');
  await quit();

  await launch();
  const reopened = await current();
  for (const key of ['width', 'height']) assert.equal(reopened[key], saved[key], `窗口${key}应当沿用上次的尺寸`);
  // Restored windows land where the last one was; macOS may nudge them by a pixel or two.
  for (const key of ['x', 'y']) assert.ok(Math.abs(reopened[key] - saved[key]) <= 8, `窗口${key}应当沿用上次的位置：${JSON.stringify(reopened)} vs ${JSON.stringify(saved)}`);
  assert.deepEqual(errors, []);
  console.log('Window state smoke passed:', JSON.stringify(saved), '->', JSON.stringify(reopened));
} finally {
  try { await app?.close(); } catch { /* Already closed. */ }
  await fs.rm(root, { recursive: true, force: true });
}
