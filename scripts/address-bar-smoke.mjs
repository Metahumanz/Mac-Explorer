import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-address-bar-'));
for (const folder of ['Documents/A', 'Documents/alpha', 'Documents/Beta', 'Documents/.hidden-a', 'Documents/Archive.app', 'Desktop', 'Downloads']) await fs.mkdir(path.join(root, folder), { recursive: true });
await fs.writeFile(path.join(root, 'Documents', 'a-file.txt'), '');
for (let index = 0; index < 6; index++) await fs.mkdir(path.join(root, 'Downloads', `Item ${index}`));
const docs = path.join(root, 'Documents'); const folderA = path.join(docs, 'A'); const desktop = path.join(root, 'Desktop');
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
  // Copying an address writes the system clipboard; restore the user's contents afterwards.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const at = name => page.locator(`.file-content[aria-label="${name}"][aria-busy="false"]`).waitFor();
  const input = page.getByRole('textbox', { name: '文件夹地址', exact: true });
  const list = page.locator('#address-suggestions');
  const options = async () => { await page.waitForTimeout(150); return (await list.count()) ? list.getByRole('option').allTextContents() : []; };
  const edit = async () => { await page.keyboard.press('Meta+Shift+g'); await input.waitFor(); };
  const go = async value => { await edit(); await input.fill(value); await input.press('Enter'); };
  await at('文档');
  await edit(); assert.deepEqual(await options(), []); // No history yet.
  await input.press('Escape');
  await go(folderA); await at('A');
  await go('~/Desktop'); await at('桌面'); // Recorded as the resolved folder.
  await go(path.join(root, 'missing')); await page.getByRole('alert').waitFor(); // Failures are not recorded.
  await input.press('Escape');

  // Before typing, the dropdown lists addresses navigated from the address bar, newest first.
  await edit();
  assert.deepEqual(await options(), [desktop, folderA]);
  await input.press('ArrowDown'); await input.press('ArrowDown');
  assert.equal(await input.inputValue(), folderA);
  assert.deepEqual(await options(), [desktop, folderA]); // Arrowing does not narrow the list.
  await list.getByRole('option', { name: folderA, exact: true }).click(); await at('A');
  await edit(); assert.deepEqual(await options(), [folderA, desktop]);

  // After a slash, subfolders match by case-insensitive prefix; files, bundles and hidden folders are excluded.
  await input.fill(docs + '/a');
  assert.deepEqual(await options(), [folderA, path.join(docs, 'alpha')]);
  await input.fill(docs + '/');
  assert.deepEqual(await options(), [folderA, path.join(docs, 'alpha'), path.join(docs, 'Beta')]);
  await input.fill('~/Downloads/it');
  assert.equal((await options()).length, 5); // At most five candidates.
  assert.ok((await options()).every(value => value.startsWith('~/Downloads/Item ')));
  await input.fill('~/de');
  assert.deepEqual(await options(), ['~/Desktop']);
  await input.press('ArrowDown'); await input.press('Enter'); await at('桌面');
  await page.reload(); await at('文档');
  await edit(); assert.deepEqual(await options(), [desktop, folderA]); // Persisted; picking ~/Desktop moved it to the top.

  await input.press('Escape');
  // Breadcrumb chevrons list the subfolders of the crumb before them.
  const crumbMenu = async name => { await page.getByRole('button', { name: `${name} 的子文件夹`, exact: true }).click(); await page.locator('.context-menu').waitFor(); return page.locator('.context-menu button').allTextContents(); };
  assert.deepEqual(await crumbMenu('文档'), ['A', 'alpha', 'Beta']);
  await page.locator('.context-menu button').filter({ hasText: /^alpha$/ }).click(); await at('alpha');
  assert.deepEqual(await crumbMenu('alpha'), ['没有子文件夹']);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('textbox', { name: '文件夹地址', exact: true }).count(), 0); // Chevrons do not start editing.
  // Right-clicking a crumb copies its path; the empty area copies the current location.
  const copied = () => app.evaluate(({ clipboard }) => clipboard.readText());
  await page.locator('.breadcrumbs button:not(.crumb-chevron)').filter({ hasText: /^文档$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制地址', exact: true }).click();
  for (let i = 0; i < 40 && await copied() !== docs; i++) await page.waitForTimeout(50);
  assert.equal(await copied(), docs);
  const box = await page.locator('.breadcrumbs').boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: '复制地址', exact: true }).click();
  for (let i = 0; i < 40 && await copied() !== path.join(docs, 'alpha'); i++) await page.waitForTimeout(50);
  assert.equal(await copied(), path.join(docs, 'alpha'));
  console.log('PASS: history before typing, newest first, resolved and failure-free, arrow keys keep the list, prefix folder candidates capped at five, persistence, breadcrumb subfolder menus, copy address.');
} finally {
  await app.evaluate(async ({ clipboard }) => { if (globalThis.savedClipboard?.length) await clipboard.write(globalThis.savedClipboard); else clipboard.clear(); }).catch(() => {});
  await app.close(); await fs.rm(root, { recursive: true, force: true });
}
