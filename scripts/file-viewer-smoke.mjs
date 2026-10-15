import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-file-viewer-'));
const binary = process.env.EXPLORER_APP_PATH
  ? path.resolve(process.env.EXPLORER_APP_PATH, '../../Resources/app.asar.unpacked/dist-electron/native/file-viewer')
  : path.resolve('dist-electron/native/file-viewer');
const system = path.join(root, 'file-viewer-system.plist');
const backup = path.join(root, 'original.plist');
const appID = 'local.macexplorer.desktop';
const folder = (id, role = 'All') => ({ LSHandlerContentType: 'public.folder', [`LSHandlerRole${role}`]: id });
const unrelated = { LSHandlerContentType: 'public.text', LSHandlerRoleAll: 'example.editor' };
async function write(file, value) {
  await fs.writeFile(file, JSON.stringify(value));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', file]);
}
const read = file => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
function run(action, options = {}) {
  return JSON.parse(execFileSync(binary, [action, options.backup || backup], {
    env: { ...process.env, EXPLORER_TEST_ROOT: root, ...options.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}
let app, page;
async function launch() {
  app = await electron.launch({ colorScheme: null,
    ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }),
    env: { ...process.env, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' },
  });
  page = await app.firstWindow(); page.setDefaultTimeout(10_000);
  await page.getByRole('tab').first().waitFor();
}
async function settings(target = page) {
  await target.getByRole('button', { name: '更多', exact: true }).click();
  await target.getByRole('menuitem', { name: '设置…', exact: true }).click();
  await target.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await target.getByRole('switch').waitFor({ state: 'visible' });
  await target.waitForFunction(() => !document.querySelector('[role="switch"]').disabled);
}
try {
  const original = { global: 'example.viewer', handlers: [folder('example.viewer', 'Viewer'), unrelated, folder('example.editor', 'Editor')] };
  await write(system, original);
  assert.equal(run('status').enabled, false);
  assert.equal(run('enable').canRestore, true);
  const saved = await fs.readFile(backup);
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  assert.deepEqual(read(system).handlers, [unrelated, folder(appID)]);
  run('enable'); assert.deepEqual(await fs.readFile(backup), saved);
  assert.equal(run('status').enabled, true);
  // Preserve unrelated associations added while enabled, including during restore.
  const added = { LSHandlerContentType: 'public.image', LSHandlerRoleAll: 'example.images' };
  await write(system, { ...read(system), handlers: [...read(system).handlers, added] });
  assert.equal(run('restore').enabled, false);
  assert.deepEqual(read(system), { ...original, handlers: [...original.handlers, added] });
  await assert.rejects(fs.access(backup));
  for (const initial of [{}, { handlers: [] }]) {
    await write(system, initial); run('enable'); run('restore'); assert.deepEqual(read(system), initial);
  }
  await write(system, original);
  assert.throws(() => run('enable', { env: { EXPLORER_TEST_FILE_VIEWER_FAIL_WRITE: '1' } }), /无法保存/);
  assert.deepEqual(read(system), original); assert.equal(run('status').enabled, false);
  run('enable'); const enabled = read(system);
  assert.throws(() => run('restore', { env: { EXPLORER_TEST_FILE_VIEWER_FAIL_WRITE: '1' } }), /无法保存/);
  assert.deepEqual(read(system), enabled); assert.equal(run('status').canRestore, true);
  const external = { ...enabled, global: 'example.other' };
  await write(system, external);
  assert.equal(run('status').canRestore, false);
  for (const action of ['enable', 'restore']) assert.throws(() => run(action), /其他应用更改/);
  assert.deepEqual(read(system), external);
  await write(system, enabled); await fs.unlink(backup);
  assert.equal(run('status').canRestore, false);
  assert.throws(() => run('restore'), /原设置备份/);
  assert.throws(() => run('enable'), /原设置备份/);
  await write(system, original); await fs.writeFile(backup, 'broken');
  assert.throws(() => run('enable'), /原设置备份/); assert.deepEqual(read(system), original);
  await fs.unlink(backup); await fs.symlink(system, backup);
  assert.throws(() => run('enable'), /原设置备份/); assert.deepEqual(read(system), original);
  await fs.unlink(backup);
  const blocked = path.join(root, 'blocked'); await fs.writeFile(blocked, 'file');
  assert.throws(() => run('enable', { backup: path.join(blocked, 'backup.plist') }));
  assert.deepEqual(read(system), original);

  await fs.mkdir(path.join(root, 'Documents'));
  await launch(); await settings();
  const toggle = () => page.getByRole('switch', { name: '使用 Mac Explorer 显示文件', exact: true });
  assert.equal(await toggle().isChecked(), false);
  const help = () => page.getByRole('button', { name: '文件查看器说明', exact: true });
  const bubble = () => page.locator('.settings-help').first().getByRole('tooltip', { includeHidden: true });
  assert.equal(await bubble().isVisible(), false);
  assert.ok(await toggle().locator('xpath=../..').evaluate(element => element.getBoundingClientRect().height) < 40);
  await help().hover(); await page.getByRole('tooltip').waitFor();
  const helpBounds = await help().boundingBox(); const bubbleBounds = await bubble().boundingBox();
  await page.mouse.move(helpBounds.x + helpBounds.width / 2, bubbleBounds.y + 10, { steps: 12 });
  assert.equal(await bubble().isVisible(), true);
  for (const text of ['部分软件仍会调用 Finder，菜单名称也可能保持不变。普通文件夹的打开方式可能需要重新登录或重启后生效。', '不会替换桌面及系统“打开／保存”窗口。']) {
    assert.equal(await page.getByText(text, { exact: true }).isVisible(), true);
  }
  await page.getByRole('heading', { name: '设置', exact: true }).hover();
  await page.waitForFunction(() => !document.querySelector('[role=tooltip]').matches(':popover-open'));
  await help().focus(); await page.getByRole('tooltip').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await bubble().isVisible(), false);
  assert.equal(await page.getByRole('dialog', { name: '设置', exact: true }).isVisible(), true);
  await page.keyboard.press('Tab');
  await assert.rejects(page.evaluate(() => window.explorer.setFileViewer('yes')), /无效/);
  await toggle().click();
  await page.waitForFunction(() => window.explorer.fileViewerSettings().then(value => value.enabled && value.canRestore).catch(() => false));
  assert.equal(await toggle().isChecked(), true);
  await app.close(); await launch(); await settings();
  assert.equal(await toggle().isChecked(), true);
  const windowEvent = app.waitForEvent('window');
  await app.evaluate(({ app }) => app.dock.getMenu().items.find(item => item.label === '新建窗口').click());
  const second = await windowEvent; await second.getByRole('tab').first().waitFor(); await settings(second);
  await toggle().click();
  await second.waitForFunction(() => !document.querySelector('[role="switch"]').checked);
  assert.deepEqual(read(system), original);
  assert.equal(await toggle().isChecked(), false);
  await second.close();
  await fs.mkdir('artifacts/file-viewer', { recursive: true });
  const owner = await app.browserWindow(page); await owner.evaluate(window => window.setSize(800,760));
  await page.waitForFunction(() => innerWidth <= 800);
  assert.equal(await page.getByRole('tabpanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await help().hover(); await page.getByRole('tooltip').waitFor();
  assert.equal(await bubble().evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
  await page.waitForFunction(() => Promise.all(document.querySelector('dialog').getAnimations().map(animation => animation.finished)).then(() => true));
  await page.screenshot({ path: path.resolve('artifacts/file-viewer/settings-light-fixture.png') });
  await page.getByRole('heading', { name: '设置', exact: true }).hover();
  const vcsHelp = page.getByRole('button', { name: '版本控制说明', exact: true });
  const vcsBubble = page.locator('.settings-help').last().getByRole('tooltip', { includeHidden: true });
  assert.equal(await vcsBubble.isVisible(), false);
  await vcsHelp.scrollIntoViewIfNeeded(); await page.evaluate(() => new Promise(requestAnimationFrame));
  await vcsHelp.hover(); await page.getByRole('tooltip').waitFor();
  assert.equal(await page.getByRole('tooltip').count(), 1);
  assert.equal(await page.getByText('仅在仓库内启用。关闭后停止状态检测与刷新；需要已安装 Git 或 SVN 命令行工具。', { exact: true }).isVisible(), true);
  await page.screenshot({ path: path.resolve('artifacts/file-viewer/vcs-help-light-fixture.png') });
  await page.getByRole('heading', { name: '设置', exact: true }).hover();
  await page.waitForFunction(() => !document.querySelectorAll('[role=tooltip]')[1].matches(':popover-open'));
  await vcsHelp.focus(); await page.getByRole('tooltip').waitFor(); await page.keyboard.press('Escape');
  assert.equal(await vcsBubble.isVisible(), false);
  assert.equal((await page.evaluate(() => window.explorer.settings())).versionControl, true);
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.evaluate(() => window.explorer.setLanguage('en'));
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'Command+,').click());
  await page.getByRole('switch', { name: 'Show files in Mac Explorer', exact: true }).waitFor();
  assert.equal(await page.getByRole('tabpanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  assert.equal(await bubble().isVisible(), false);
  await page.getByRole('heading', { name: 'Settings', exact: true }).hover();
  await page.getByRole('button', { name: 'File viewer help', exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.getByRole('button', { name: 'File viewer help', exact: true }).hover(); await page.getByRole('tooltip').waitFor();
  assert.equal(await page.getByText('Does not replace the desktop or system Open/Save dialogs.', { exact: true }).isVisible(), true);
  assert.equal(await bubble().evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
  await page.waitForFunction(() => Promise.all(document.querySelector('dialog').getAnimations().map(animation => animation.finished)).then(() => true));
  await page.screenshot({ path: path.resolve('artifacts/file-viewer/settings-dark-english-fixture.png') });
  await page.getByRole('heading', { name: 'Settings', exact: true }).hover();
  await page.getByRole('button', { name: 'Version control help', exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.getByRole('button', { name: 'Version control help', exact: true }).hover(); await page.getByRole('tooltip').waitFor();
  assert.equal(await page.getByRole('tooltip').count(), 1);
  assert.equal(await vcsBubble.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
  await page.screenshot({ path: path.resolve('artifacts/file-viewer/vcs-help-dark-english-fixture.png') });
  console.log('PASS: isolated native preferences, exact restore, unrelated associations preserved, backup protection, conflicts, partial-write rollback; settings switch, collapsed help, hover/focus/Escape, bubble bounds, restrictions, IPC validation, restart, two-window sync, 800px layout. No real system preferences changed.');
} finally { await app?.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); }
