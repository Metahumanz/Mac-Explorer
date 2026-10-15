import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-quick-access-'));
for (const folder of ['Documents/A', 'Documents/B', 'Desktop', 'Downloads']) await fs.mkdir(path.join(root, folder), { recursive: true });
await fs.writeFile(path.join(root, 'Documents', 'note.txt'), 'preserved content');
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.locator('.file-content[aria-busy="false"]').waitFor();
  const section = page.locator('.sidebar-section');
  const order = () => section.locator(':scope > .tree-node > .tree-row > .nav-item > span:last-of-type, :scope > .nav-item > span:last-of-type').allTextContents();
  const place = name => section.locator(':scope > .tree-node > .tree-row, :scope > .nav-item').filter({ hasText: name }).first();
  // y is a fraction of the target row height.
  const dragTo = async (source, name, y) => {
    const box = await place(name).boundingBox();
    await source.dragTo(place(name), { targetPosition: { x: box.width / 2, y: box.height * y } });
  };
  const initial = await order();
  assert.ok(initial.length >= 3, `default places: ${initial}`);
  const [first, second] = initial; const last = initial.at(-1);
  await dragTo(place(last), first, 0.4); // Upper half inserts before.
  assert.deepEqual(await order(), [last, ...initial.slice(0, -1)]);
  await dragTo(place(last), second, 0.6); // Lower half inserts after.
  assert.deepEqual(await order(), [first, second, last, ...initial.slice(2, -1)]);
  const reordered = await order();
  // A file-list folder dropped on a row edge is pinned there, not moved.
  await dragTo(page.getByRole('option', { name: 'A', exact: true }), first, 0.95);
  assert.deepEqual(await order(), [first, 'A', ...reordered.slice(1)]);
  assert.ok((await fs.stat(path.join(root, 'Documents', 'A'))).isDirectory());
  // Dropping on a row centre keeps the move-into-folder behaviour.
  await dragTo(page.getByRole('option', { name: 'B', exact: true }), 'A', 0.5);
  await page.getByRole('option', { name: 'B', exact: true }).waitFor({ state: 'detached' });
  assert.ok((await fs.stat(path.join(root, 'Documents', 'A', 'B'))).isDirectory());
  assert.deepEqual(await order(), [first, 'A', ...reordered.slice(1)]);
  // Files are never pinned; an edge drop falls through to the folder move.
  await dragTo(page.getByRole('option', { name: 'note.txt', exact: true }), 'A', 0.05);
  await page.getByRole('option', { name: 'note.txt', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(path.join(root, 'Documents', 'A', 'note.txt'), 'utf8'), 'preserved content');
  assert.deepEqual(await order(), [first, 'A', ...reordered.slice(1)]);
  await page.reload(); await page.locator('.file-content[aria-busy="false"]').waitFor();
  assert.deepEqual(await order(), [first, 'A', ...reordered.slice(1)]);
  // The More menu toggles the selected folder; re-pinning appends it.
  const more = async item => { await page.getByRole('button', { name: '更多', exact: true }).click(); await page.getByRole('menuitem', { name: item }).click(); };
  await page.getByRole('option', { name: 'A', exact: true }).click();
  await more('从快速访问取消固定');
  assert.deepEqual(await order(), reordered);
  await more('固定到快速访问');
  assert.deepEqual(await order(), [...reordered, 'A']);
  console.log('PASS: Quick Access reorder before/after, folder pinning at row edges, centre drop moves, files not pinned, order persists, More menu pin toggle.');
} finally {
  await app.close(); await fs.rm(root, { recursive: true, force: true });
}
