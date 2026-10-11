import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Only reads the current state: switching defaults and restarting Finder are visible,
// system-wide changes that a regression run must not perform on the user's Mac.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-defaultapp-'));
await fs.mkdir(path.join(root, 'Documents'));
await fs.writeFile(path.join(root, 'Documents', '使用说明.txt'), '默认应用测试 fixture。');
let app, page;
const errors = [];
try {
  app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root } });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('option', { name: '使用说明.txt', exact: true }).waitFor();

  const state = await page.evaluate(() => window.explorer.defaultAppStatus());
  assert.equal(typeof state.login, 'boolean');
  assert.equal(typeof state.desktop, 'boolean');
  assert.equal(typeof state.installed, 'boolean');
  assert.deepEqual(Object.keys(state.handlers).sort(), ['archive', 'image', 'pdf', 'text']);
  console.log('state:', JSON.stringify(state));

  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '默认应用', exact: true }).hover();
  const menu = page.getByRole('menu', { name: '默认应用', exact: true });
  await menu.waitFor();
  // Checked entries are rendered as checkboxes, plain entries as menu items.
  const login = menu.getByRole('menuitemcheckbox', { name: '登录时自动启动', exact: true });
  await login.waitFor();
  await menu.getByRole('menuitemcheckbox', { name: '接管桌面（隐藏访达桌面图标）', exact: true }).waitFor();
  // A login item can only be registered from an installed application.
  assert.equal(await login.isDisabled(), !state.installed, '未安装到 Applications 时登录项应当禁用');

  await menu.getByRole('menuitem', { name: '用 Mac Explorer 打开以下文件', exact: true }).hover();
  const types = page.getByRole('menu', { name: '用 Mac Explorer 打开以下文件', exact: true });
  await types.getByRole('menuitemcheckbox', { name: 'ZIP 压缩文件', exact: true }).waitFor();
  for (const label of ['PDF 文档', 'PNG 图像', '文本文档']) await types.getByRole('menuitemcheckbox', { name: label, exact: true }).waitFor();

  assert.deepEqual(errors, []);
  console.log('Default app smoke passed: menu and state are consistent.');
} finally {
  try { await app?.close(); } catch { /* Already closed. */ }
  await fs.rm(root, { recursive: true, force: true });
}
