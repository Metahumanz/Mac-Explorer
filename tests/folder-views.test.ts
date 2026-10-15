import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FolderViews } from '../electron/folder-views';
import { defaultFolderView, type FolderView } from '../shared/folder-views';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-explorer-folder-views-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const details = { view: 'details', iconSize: 64 } as const;
const byDate = { sort: 'modified', ascending: false } as const;

test('evicts the least recently opened or changed folders past the limit and persists recency', () => fixture(async root => {
  const file = path.join(root, 'folder-views.json');
  const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map(async name => { await fs.mkdir(path.join(root, name)); return path.join(root, name); }));
  const store = new FolderViews(file, 3);
  for (const location of [a, b, c]) await store.set(location, { layout: details });
  await store.touch(a);
  await store.set(d, { sort: byDate });
  assert.deepEqual(Object.keys(store.overrides()), [c, a, d]);
  const reloaded = new FolderViews(file, 3); await reloaded.load();
  assert.deepEqual(Object.keys(reloaded.overrides()), [c, a, d]);
  assert.deepEqual(reloaded.overrides()[d], { sort: byDate });
}));

test('a group set back to the defaults follows them again, and an empty override is removed', () => fixture(async root => {
  const store = new FolderViews(path.join(root, 'folder-views.json'));
  assert.deepEqual(await store.set('computer', { layout: details, sort: byDate }), { layout: details, sort: byDate });
  assert.deepEqual(await store.set('computer', { layout: { view: defaultFolderView.view, iconSize: defaultFolderView.iconSize }, sort: byDate }), { sort: byDate });
  assert.equal(await store.set('computer', { sort: { sort: defaultFolderView.sort, ascending: defaultFolderView.ascending } }), null);
  assert.deepEqual(store.overrides(), {});
}));

test('changing the defaults keeps overrides, including ones that now equal the defaults, across restarts', () => fixture(async root => {
  const file = path.join(root, 'folder-views.json');
  const store = new FolderViews(file);
  await store.set('computer', { layout: details });
  const next: FolderView = { ...defaultFolderView, ...details };
  await store.setDefaults(next);
  const reloaded = new FolderViews(file); await reloaded.load();
  assert.deepEqual(reloaded.defaults, next);
  assert.deepEqual(reloaded.overrides(), { computer: { layout: details } });
}));

test('opening a vanished folder drops its entry while virtual locations stay', () => fixture(async root => {
  const gone = path.join(root, 'gone');
  await fs.mkdir(gone);
  const store = new FolderViews(path.join(root, 'folder-views.json'));
  await store.set(gone, { layout: details }); await store.set('computer', { sort: byDate });
  await fs.rm(gone, { recursive: true });
  await store.touch(gone); await store.touch('computer');
  assert.deepEqual(store.overrides(), { computer: { sort: byDate } });
}));

test('applying to all folders replaces the defaults and clears overrides', () => fixture(async root => {
  const file = path.join(root, 'folder-views.json');
  const store = new FolderViews(file);
  await store.set('computer', { layout: details });
  const next: FolderView = { ...details, ...byDate };
  await store.reset(next);
  const reloaded = new FolderViews(file); await reloaded.load();
  assert.deepEqual([reloaded.defaults, reloaded.overrides()], [next, {}]);
}));

test('imports legacy layouts over stored ones and seeds only unsaved defaults with the legacy sort', () => fixture(async root => {
  const store = new FolderViews(path.join(root, 'folder-views.json'));
  await store.set('computer', { layout: details, sort: byDate });
  await store.importLegacy({ layouts: { computer: { view: 'list', iconSize: 64 }, trash: { view: 'huge', iconSize: 64 } as never }, sort: { sort: 'size', ascending: true } });
  assert.deepEqual(store.overrides(), { computer: { layout: { view: 'list', iconSize: 64 }, sort: byDate } });
  assert.deepEqual(store.defaults, { ...defaultFolderView, sort: 'size', ascending: true });
  await store.importLegacy({ layouts: {}, sort: { sort: 'type', ascending: false } });
  assert.equal(store.defaults.sort, 'size');
}));

test('ignores corrupt or invalid saved settings', () => fixture(async root => {
  const file = path.join(root, 'folder-views.json');
  await fs.writeFile(file, JSON.stringify({ defaults: { view: 'huge' }, folders: [['computer', { layout: { view: 'icons', iconSize: 999 } }], ['trash', { sort: byDate, extra: 1 }]] }));
  const store = new FolderViews(file); await store.load();
  assert.deepEqual([store.defaults, store.overrides()], [defaultFolderView, { trash: { sort: byDate } }]);
  await fs.writeFile(file, '{');
  const empty = new FolderViews(file); await empty.load();
  assert.deepEqual([empty.defaults, empty.overrides()], [defaultFolderView, {}]);
}));
