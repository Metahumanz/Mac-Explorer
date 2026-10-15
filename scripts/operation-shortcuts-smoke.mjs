import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-operation-keys-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(docs);
await fs.writeFile(path.join(docs, 'sample.txt'), 'preserved content');
let app, page;
async function launch() {
  app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  await page.getByRole('tab').waitFor();
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
}
async function close() {
  await app.evaluate(async ({ clipboard }) => { if (globalThis.savedClipboard?.length) await clipboard.write(globalThis.savedClipboard); else clipboard.clear(); });
  await app.close();
}
async function settings() {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'Command+,').click());
  await page.getByRole('tab', { name: '键盘快捷键', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="唤醒快捷键"]').disabled);
}
const binding = name => page.getByRole('textbox', { name: `${name}的快捷键`, exact: true });
const state = () => page.evaluate(() => window.explorer.settings());
const save = () => page.getByRole('button', { name: '保存操作快捷键', exact: true });
const dismiss = () => page.getByRole('button', { name: '关闭设置', exact: true }).click();
const row = name => page.getByRole('option', { name, exact: true });
const nativeKey = label => app.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.label === label)?.accelerator ?? '', label);
try {
  await launch(); await settings();
  assert.equal(await page.locator('.operation-shortcut').count(), 27);
  assert.equal(await binding('重命名').inputValue(), 'Return / F2');
  for (const [key, message] of [['Control+c', '复制'], ['Meta+,', '保留']]) {
    await binding('重命名').press(key);
    assert.match(await page.getByRole('alert').innerText(), new RegExp(message));
    assert.equal(await save().isDisabled(), true);
    assert.deepEqual((await state()).operationShortcuts, {});
  }
  await page.evaluate(() => window.explorer.setWakeShortcut('Command+Alt+K'));
  await binding('重命名').press('Alt+Meta+k');
  assert.match(await page.getByRole('alert').innerText(), /唤醒/);
  assert.equal(await save().isDisabled(), true);
  await assert.rejects(page.evaluate(() => window.explorer.setOperationShortcuts({ rename: ['Control+C'] })), /复制/);
  await assert.rejects(page.evaluate(() => window.explorer.setOperationShortcuts({ rename: ['Command+Alt+K'] })), /唤醒/);
  await binding('重命名').press('Meta+Alt+r');
  await binding('新建标签页').press('Meta+Alt+t');
  await binding('复制').press('Meta+Alt+c');
  await page.getByRole('textbox', { name: '唤醒快捷键', exact: true }).press('Meta+Alt+u');
  await save().click();
  const expected = { rename: ['Command+Alt+R'], copy: ['Command+Alt+C'], 'new-tab': ['Command+Alt+T'] };
  await page.waitForFunction(expected => window.explorer.settings().then(s => Object.entries(expected).every(([id, keys]) => JSON.stringify(s.operationShortcuts[id]) === JSON.stringify(keys))), expected);
  assert.equal(await page.getByRole('textbox', { name: '唤醒快捷键', exact: true }).inputValue(), '⌘+⌥+U');
  assert.equal((await state()).wakeShortcut, 'Command+Alt+K');
  assert.equal(await nativeKey('新建标签页'), 'Command+Alt+T');
  assert.equal(await nativeKey('复制'), 'Command+Alt+C');
  await assert.rejects(page.evaluate(() => window.explorer.setWakeShortcut('Alt+Command+T')), /唤醒/);
  await dismiss();
  await page.getByRole('button', { name: '新建标签页 (⌥⌘T)', exact: true }).waitFor();
  await page.getByRole('button', { name: '重命名 (⌥⌘R)', exact: true }).waitFor();
  await row('sample.txt').click();
  for (const old of ['Enter', 'F2']) { await page.keyboard.press(old); assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).count(), 0); }
  await page.keyboard.press('Meta+Alt+r');
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('renamed.txt');
  await page.keyboard.press('Enter'); await row('renamed.txt').waitFor();
  assert.equal(await fs.readFile(path.join(docs, 'renamed.txt'), 'utf8'), 'preserved content');
  await row('renamed.txt').click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('old copy keys are disabled'));
  for (const old of ['Meta+c', 'Control+c']) { await page.keyboard.press(old); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'old copy keys are disabled'); }
  await page.keyboard.press('Meta+Alt+c');
  await page.waitForFunction(() => window.explorer.clipboardGet().then(value => value.paths.some(file => file.endsWith('/renamed.txt'))));
  const count = await page.getByRole('tab').count();
  for (const old of ['Meta+t', 'Control+t']) { await page.keyboard.press(old); assert.equal(await page.getByRole('tab').count(), count); }
  await page.keyboard.press('Meta+Alt+t');
  await page.waitForFunction(count => document.querySelectorAll('.tab').length === count + 1, count);
  await page.getByRole('button', { name: '编辑地址 (⇧⌘G)', exact: true }).click();
  const address = page.getByRole('textbox', { name: '文件夹地址', exact: true });
  await address.fill('text editing stays local'); await address.press('Meta+a'); await address.press('Meta+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'text editing stays local');
  await address.fill(''); await address.press('Meta+v');
  assert.equal(await address.inputValue(), 'text editing stays local');
  await address.press('Meta+Alt+t'); assert.equal(await page.getByRole('tab').count(), count + 1);
  await address.press('Escape');
  // Other windows receive changes immediately, including their visible hints.
  const opened = app.waitForEvent('window');
  await page.evaluate(docs => window.explorer.detachTab({ location: docs, history: [docs], index: 0 }, { x: 100, y: 100 }, false), docs);
  const other = await opened;
  await other.getByRole('button', { name: '新建标签页 (⌥⌘T)', exact: true }).waitFor();
  await page.evaluate(() => window.explorer.setOperationShortcuts({ rename: ['Command+Alt+R'], copy: ['Command+Alt+C'], 'new-tab': [] }));
  await other.getByRole('button', { name: '新建标签页', exact: true }).waitFor();
  assert.equal(await nativeKey('新建标签页'), '');
  await page.evaluate(expected => window.explorer.setOperationShortcuts(expected), expected);
  await other.getByRole('button', { name: '新建标签页 (⌥⌘T)', exact: true }).waitFor();
  await other.close();
  // A failed write cannot change live bindings, native menus, or saved preferences.
  const saved = await fs.readFile(path.join(root, '.app-data/shortcuts.json'), 'utf8');
  await app.evaluate(() => { const fs = process.getBuiltinModule('fs/promises'); globalThis.savedRename = fs.rename; fs.rename = async () => { throw new Error('fixture write failed'); }; });
  await assert.rejects(page.evaluate(() => window.explorer.setOperationShortcuts({})), /fixture write failed/);
  await app.evaluate(() => { process.getBuiltinModule('fs/promises').rename = globalThis.savedRename; });
  assert.deepEqual((await state()).operationShortcuts, expected);
  assert.equal(await nativeKey('新建标签页'), 'Command+Alt+T');
  assert.equal(await fs.readFile(path.join(root, '.app-data/shortcuts.json'), 'utf8'), saved);
  await close(); await launch();
  assert.deepEqual((await state()).operationShortcuts, expected);
  assert.equal((await state()).wakeShortcut, 'Command+Alt+K');
  assert.equal(await nativeKey('新建标签页'), 'Command+Alt+T');
  await settings();
  assert.equal(await binding('重命名').inputValue(), '⌥⌘R');
  await page.getByRole('button', { name: '清除“重命名”的快捷键', exact: true }).click();
  assert.equal(await binding('重命名').inputValue(), '');
  await save().click(); await page.waitForFunction(() => window.explorer.settings().then(s => s.operationShortcuts.rename?.length === 0));
  await page.getByRole('button', { name: '恢复“重命名”的默认快捷键', exact: true }).click();
  assert.equal(await binding('重命名').inputValue(), 'Return / F2');
  await page.getByRole('button', { name: '恢复默认快捷键', exact: true }).click();
  await save().click(); await page.waitForFunction(() => window.explorer.settings().then(s => !Object.keys(s.operationShortcuts).length));
  assert.equal(await nativeKey('新建标签页'), 'Command+T');
  for (const [key, otherKey, value] of [['Meta+=', 'Meta+Shift+=', 'Command+='], ['Meta+Shift+=', 'Meta+=', 'Command+Plus']]) {
    await binding('新建标签页').press(key); await save().click();
    assert.equal(await nativeKey('新建标签页'), value);
    await dismiss(); await page.locator('.file-content').click({ position: { x: 600, y: 400 } });
    const before = await page.getByRole('tab').count();
    await page.keyboard.press(otherKey); assert.equal(await page.getByRole('tab').count(), before);
    await page.keyboard.press(key); await page.waitForFunction(before => document.querySelectorAll('.tab').length === before + 1, before);
    await settings();
  }
  await page.getByRole('button', { name: '恢复默认快捷键', exact: true }).click(); await save().click();
  await page.evaluate(() => window.explorer.setTheme('dark'));
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  await binding('重命名').click();
  await binding('重命名').press('Control+c');
  await page.waitForFunction(() => Promise.all(document.querySelector('dialog').getAnimations().map(animation => animation.finished)).then(() => true));
  await fs.mkdir('artifacts/operation-shortcuts', { recursive: true });
  await page.screenshot({ path: path.resolve('artifacts/operation-shortcuts/conflict-dark-fixture.png') });
  await binding('重命名').press('Meta+Alt+r');
  await page.screenshot({ path: path.resolve('artifacts/operation-shortcuts/edit-dark-fixture.png') });
  await dismiss();
  assert.equal(await fs.readFile(path.join(docs, 'renamed.txt'), 'utf8'), 'preserved content');
  console.log('PASS: 27 editable operations; live alias/wake/reserved conflict checks and IPC enforcement; rename/native-menu remapping, old keys disabled, input copy/paste preserved, multi-window sync, failed-write rollback, restart persistence, clear and restore. Temporary fixtures only.');
} finally { if (app) await close().catch(() => {}); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
