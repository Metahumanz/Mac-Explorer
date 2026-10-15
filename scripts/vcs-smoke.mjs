import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-vcs-ui-'));
const docs = path.join(root, 'Documents');
const output = path.resolve('artifacts/vcs');
await fs.mkdir(docs); await fs.mkdir(output, { recursive: true });
const git = async (...args) => (await exec('/usr/bin/git', args, { cwd: docs, encoding: 'utf8' })).stdout;
await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'commit.gpgsign', 'false');
await fs.writeFile(path.join(docs, 'sample.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'fixture');
await fs.writeFile(path.join(docs, 'sample.txt'), 'modified\n'); await fs.writeFile(path.join(docs, 'new.txt'), 'untracked');
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('tab').waitFor();
}
async function capture(name) {
  await page.waitForFunction(() => Promise.all([...document.querySelectorAll('dialog, .context-menu')].flatMap(element => element.getAnimations()).map(animation => animation.finished)).then(() => true));
  await page.screenshot({ path: path.join(output, name) });
}
const row = name => page.getByRole('option', { name, exact: true });
const badge = (name, state) => row(name).locator(`[data-vcs-state="${state}"]`);
async function openVcs(name, item, kind = 'Git') {
  await row(name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
  if (kind === 'Git' && item === '查看差异…') await capture('git-menu-fixture.png');
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor(); return dialog;
}
async function settings() {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'Command+,').click());
  const dialog = page.getByRole('dialog', { name: '设置', exact: true }); await dialog.waitFor(); return dialog;
}
async function navigate(directory) {
  await page.getByRole('button', { name: /编辑地址/ }).click();
  const address = page.getByRole('textbox', { name: '文件夹地址', exact: true }); await address.fill(directory); await address.press('Enter');
}
try {
  await launch();
  await badge('sample.txt', 'modified').waitFor(); await badge('new.txt', 'untracked').waitFor();
  assert.equal((await page.evaluate(() => window.explorer.settings())).versionControl, true);
  await capture('git-badges-fixture.png');
  let dialog = await openVcs('sample.txt', '查看差异…');
  await dialog.getByText('+modified', { exact: true }).waitFor();
  await capture('git-diff-fixture.png');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  dialog = await openVcs('sample.txt', '暂存所选更改…');
  await dialog.getByRole('button', { name: '确认加入', exact: true }).click(); await dialog.getByText('操作已完成。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await git('show', ':sample.txt'), 'modified\n');
  dialog = await openVcs('sample.txt', '提交已暂存更改…');
  await dialog.getByRole('textbox', { name: '提交信息', exact: true }).fill('UI commit');
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await dialog.getByText('操作已完成。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await badge('sample.txt', 'clean').waitFor();
  assert.equal(await git('log', '-1', '--format=%s'), 'UI commit\n');
  await fs.writeFile(path.join(docs, 'sample.txt'), 'precious local\n');
  await page.getByRole('button', { name: '刷新版本状态', exact: true }).click(); await badge('sample.txt', 'modified').waitFor();
  dialog = await openVcs('sample.txt', '丢弃本地修改…');
  await dialog.getByRole('button', { name: '备份并丢弃修改', exact: true }).click(); await dialog.getByText('操作已完成。', { exact: true }).waitFor();
  const backupRoot = path.join(root, '.app-data', 'vcs-backups'); const backups = await fs.readdir(backupRoot);
  assert.equal(await fs.readFile(path.join(backupRoot, backups[0], 'files', 'sample.txt'), 'utf8'), 'precious local\n');
  assert.equal(await fs.readFile(path.join(docs, 'sample.txt'), 'utf8'), 'modified\n');
  await capture('git-backup-fixture.png');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  // The switch is shared between windows and survives closing, reopening and restarting.
  const opened = app.waitForEvent('window');
  await page.evaluate(docs => window.explorer.detachTab({ location: docs, history: [docs], index: 0 }, { x: 100, y: 100 }, false), docs);
  const other = await opened; await other.locator('[data-vcs-state]').first().waitFor();
  dialog = await settings(); const toggle = dialog.getByRole('checkbox', { name: '启用 Git / SVN 状态角标和右键菜单', exact: true });
  assert.equal(await toggle.isChecked(), true); await toggle.uncheck();
  await page.waitForFunction(() => window.explorer.settings().then(value => !value.versionControl));
  await other.waitForFunction(() => !document.querySelector('[data-vcs-state]'));
  await capture('settings-fixture.png');
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  assert.equal(await page.locator('[data-vcs-state]').count(), 0);
  await row('sample.txt').click({ button: 'right' }); assert.equal(await page.getByRole('menuitem', { name: 'Git', exact: true }).count(), 0); await page.keyboard.press('Escape');
  dialog = await settings(); assert.equal(await dialog.getByRole('checkbox', { name: '启用 Git / SVN 状态角标和右键菜单', exact: true }).isChecked(), false);
  await app.close(); await launch(); assert.equal((await page.evaluate(() => window.explorer.settings())).versionControl, false); assert.equal(await page.locator('[data-vcs-state]').count(), 0);
  dialog = await settings(); await dialog.getByRole('checkbox', { name: '启用 Git / SVN 状态角标和右键菜单', exact: true }).check();
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click(); await badge('sample.txt', 'clean').waitFor();
  dialog = await settings();
  await app.evaluate(() => { const fs = process.getBuiltinModule('fs/promises'); globalThis.vcsSavedRename = fs.rename; fs.rename = async () => { throw new Error('fixture save failure'); }; });
  await dialog.getByRole('checkbox', { name: '启用 Git / SVN 状态角标和右键菜单', exact: true }).click();
  await dialog.getByRole('alert').getByText('fixture save failure', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('checkbox', { name: '启用 Git / SVN 状态角标和右键菜单', exact: true }).isChecked(), true);
  assert.equal((await page.evaluate(() => window.explorer.settings())).versionControl, true);
  await app.evaluate(() => { process.getBuiltinModule('fs/promises').rename = globalThis.vcsSavedRename; });
  await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  await assert.rejects(page.evaluate(() => window.explorer.setVersionControl('invalid')), /无效/);
  await navigate(root); await page.waitForFunction(() => !document.querySelector('.vcs-summary')); assert.equal(await page.locator('[data-vcs-state]').count(), 0);

  // Exercise SVN through the real application with a local server repository.
  const repository = path.join(root, 'svn-repo'); const wc = path.join(root, 'SvnProject');
  await exec('/opt/homebrew/bin/svnadmin', ['create', repository]);
  await exec('/opt/homebrew/bin/svn', ['checkout', 'file://' + repository, wc]);
  await fs.writeFile(path.join(wc, 'svn-file.txt'), 'svn content\n');
  await navigate(wc); await badge('svn-file.txt', 'untracked').waitFor();
  dialog = await openVcs('svn-file.txt', '加入版本控制…', 'SVN');
  await dialog.getByRole('button', { name: '确认加入', exact: true }).click(); await dialog.getByText('操作已完成。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await badge('svn-file.txt', 'added').waitFor();
  dialog = await openVcs('svn-file.txt', '提交更改…', 'SVN');
  await dialog.getByRole('textbox', { name: '提交信息', exact: true }).fill('SVN UI commit');
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await dialog.getByText('操作已完成。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await badge('svn-file.txt', 'clean').waitFor();
  await fs.writeFile(path.join(wc, 'svn-file.txt'), 'svn modified\n');
  await page.getByRole('button', { name: '刷新版本状态', exact: true }).click(); await badge('svn-file.txt', 'modified').waitFor();
  await capture('svn-badges-fixture.png');
  dialog = await openVcs('svn-file.txt', '查看差异…', 'SVN'); await dialog.getByText('+svn modified', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  dialog = await openVcs('svn-file.txt', '丢弃本地修改…', 'SVN');
  await dialog.getByRole('button', { name: '备份并丢弃修改', exact: true }).click(); await dialog.getByText('操作已完成。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); assert.equal(await fs.readFile(path.join(wc, 'svn-file.txt'), 'utf8'), 'svn content\n');
  assert.deepEqual(errors, []);
  console.log('PASS: real Electron Git/SVN badges, menus, diff, staging, commit, backed-up discard, ordinary directories, default-on switch, multiwindow sync, reopen and restart persistence.');
} finally {
  if (app) await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
