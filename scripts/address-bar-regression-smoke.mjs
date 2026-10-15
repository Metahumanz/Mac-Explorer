import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-address-regression-'));
const docs = path.join(root, 'Documents');
const desktop = path.join(root, 'Desktop');
for (const name of ['Documents/OldChild', 'Desktop/NewChild', 'Downloads']) await fs.mkdir(path.join(root, name), { recursive: true });
const histories = Array.from({ length: 25 }, (_, index) => path.join(root, `History ${String(index).padStart(2, '0')}`));
for (const directory of histories) await fs.mkdir(directory);
const output = path.resolve('artifacts/address-bar');
await fs.mkdir(output, { recursive: true });
const nativeNetwork = path.join(root, 'network-fixture.dylib');
let app;
const results = [];
try {
  // Reuse the native NetFS fixture: cancellation and success traverse the real helper and IPC validation.
  execFileSync('xcrun', ['clang', '-dynamiclib', '-framework', 'CoreFoundation', '-framework', 'NetFS', 'tests/fixtures/NetworkFixture.c', '-o', nativeNetwork]);
  execFileSync('codesign', ['--force', '--sign', '-', nativeNetwork]);
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
  const page = await app.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const at = name => page.locator(`.file-content[aria-label="${name}"][aria-busy="false"]`).waitFor();
  const sidebar = name => page.getByRole('navigation', { name: '文件位置', exact: true }).getByRole('button', { name, exact: true });
  const input = page.getByRole('textbox', { name: '文件夹地址', exact: true });
  const menu = page.locator('.context-menu');
  const history = () => page.evaluate(() => JSON.parse(localStorage.getItem('typedPaths') || '[]'));
  await at('文档');
  await app.evaluate(({}, { nativeNetwork, desktop }) => {
    process.env.DYLD_INSERT_LIBRARIES = nativeNetwork;
    process.env.EXPLORER_FIXTURE_MOUNT_PATH = desktop;
    const files = process.getBuiltinModule('fs/promises');
    const original = files.readdir; globalThis.savedReaddir = original;
    files.readdir = async function (...args) {
      if (String(args[0]) === globalThis.crumbDirectory && !globalThis.crumbReadStarted) {
        globalThis.crumbReadStarted = true;
        await new Promise(resolve => { globalThis.releaseCrumbRead = resolve; });
        try {
          if (globalThis.crumbReadError) throw new Error('Stale breadcrumb fixture');
          return await original.apply(this, args);
        } finally { globalThis.crumbReadReturned = true; }
      }
      return original.apply(this, args);
    };
  }, { nativeNetwork, desktop });
  const holdCrumb = async (error = false) => {
    await app.evaluate(({}, { docs, error }) => {
      globalThis.crumbDirectory = docs; globalThis.crumbReadStarted = false;
      globalThis.crumbReadReturned = false; globalThis.crumbReadError = error;
    }, { docs, error });
    await page.getByRole('button', { name: '文档 的子文件夹', exact: true }).click();
    for (let index = 0; index < 100 && !await app.evaluate(() => globalThis.crumbReadStarted); index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await app.evaluate(() => globalThis.crumbReadStarted), true);
  };
  const releaseCrumb = async () => {
    await app.evaluate(() => globalThis.releaseCrumbRead());
    for (let index = 0; index < 100 && !await app.evaluate(() => globalThis.crumbReadReturned); index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await app.evaluate(() => globalThis.crumbReadReturned), true);
    // Allow the resumed read's entry metadata and renderer reply to settle before negative assertions.
    await page.waitForTimeout(500);
  };

  await holdCrumb();
  await sidebar('桌面').click(); await at('桌面');
  await page.getByRole('option', { name: 'NewChild', exact: true }).waitFor();
  await releaseCrumb(); assert.equal(await menu.count(), 0);
  await page.screenshot({ path: path.join(output, 'navigation-fixture.png') });
  results.push({ case: 'Navigation invalidates an in-flight breadcrumb menu', passed: true });

  await sidebar('文档').click(); await at('文档');
  await holdCrumb(); await page.keyboard.press('Escape');
  await releaseCrumb(); assert.equal(await menu.count(), 0);
  await holdCrumb(); await page.locator('.status-bar > span').first().click();
  await releaseCrumb(); assert.equal(await menu.count(), 0);
  await holdCrumb();
  await page.getByRole('button', { name: '文档 的子文件夹', exact: true }).click();
  await menu.waitFor(); assert.deepEqual(await menu.locator('button').allTextContents(), ['OldChild']);
  await page.keyboard.press('Escape'); await releaseCrumb(); assert.equal(await menu.count(), 0);
  await holdCrumb(true); await sidebar('桌面').click(); await at('桌面');
  await releaseCrumb(); assert.equal(await page.getByRole('alert').count(), 0);
  results.push({ case: 'Dismissal, newer requests and navigation also invalidate delayed errors', passed: true });
  await app.evaluate(() => { process.getBuiltinModule('fs/promises').readdir = globalThis.savedReaddir; });

  const submitSMB = async mode => {
    await app.evaluate(({}, value) => { process.env.EXPLORER_FIXTURE_NETWORK_MODE = value; }, mode);
    await page.keyboard.press('Meta+Shift+g'); await input.fill('smb://fixture/share'); await input.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.status-feedback .spinning'));
  };
  await submitSMB('cancel'); await at('桌面');
  assert.deepEqual(await history(), []); assert.equal(await page.getByRole('alert').count(), 0);
  await submitSMB('error'); await page.getByRole('alert').filter({ hasText: '无法连接服务器' }).waitFor();
  assert.deepEqual(await history(), []);
  await submitSMB(''); await at('桌面');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('typedPaths') || '[]').includes('smb://fixture/share'));
  assert.deepEqual(await history(), ['smb://fixture/share']);
  results.push({ case: 'Only a successful native SMB connection enters address history', passed: true });

  await page.evaluate(values => localStorage.setItem('typedPaths', JSON.stringify(values)), histories);
  await page.reload(); await at('文档'); await page.keyboard.press('Meta+Shift+g');
  const list = page.locator('#address-suggestions'); await list.getByRole('option').last().waitFor();
  assert.equal(await list.getByRole('option').count(), 25);
  const assertVisible = async expected => {
    assert.equal(await input.inputValue(), expected);
    const geometry = await list.evaluate(element => {
      const active = element.querySelector('[aria-selected=true]');
      const container = element.getBoundingClientRect(); const row = active.getBoundingClientRect();
      return { scrollTop: element.scrollTop, visible: row.top >= container.top && row.bottom <= container.bottom };
    });
    assert.equal(geometry.visible, true);
    return geometry;
  };
  await input.press('ArrowUp'); assert.ok((await assertVisible(histories[24])).scrollTop > 0);
  await page.screenshot({ path: path.join(output, 'history-selection-fixture.png') });
  await input.press('ArrowDown'); await assertVisible(histories[0]);
  for (let index = 1; index < 25; index++) { await input.press('ArrowDown'); await assertVisible(histories[index]); }
  assert.deepEqual(await list.getByRole('option').allTextContents(), histories);
  results.push({ case: 'All 25 history entries and keyboard wraparound stay visible', passed: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'regression-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  console.log('PASS: stale breadcrumb responses, native SMB cancellation/error/success, and keyboard history scrolling.');
} finally {
  await app?.evaluate(() => { globalThis.releaseCrumbRead?.(); if (globalThis.savedReaddir) process.getBuiltinModule('fs/promises').readdir = globalThis.savedReaddir; }).catch(() => {});
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
