import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileProperties } from '../electron/properties';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-properties-'));
  try { await run(root); } finally { await fs.chmod(path.join(root, 'locked'), 0o700).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); }
}

test('folder properties include hidden and nested contents, with file allocation totals', () => fixture(async root => {
  await fs.mkdir(path.join(root, '子目录'));
  await fs.mkdir(path.join(root, 'empty'));
  await fs.writeFile(path.join(root, '.隐藏.txt'), 'hidden');
  await fs.writeFile(path.join(root, '子目录/中文 #%.txt'), 'nested');
  const stats = await Promise.all(['.隐藏.txt', '子目录/中文 #%.txt'].map(name => fs.lstat(path.join(root, name))));
  const result = await fileProperties([root]);
  assert.equal(result.size, stats.reduce((sum, stat) => sum + stat.size, 0));
  assert.equal(result.allocated, stats.reduce((sum, stat) => sum + stat.blocks * 512, 0));
  assert.equal(result.files, 2); assert.equal(result.folders, 2); assert.equal(result.skipped, 0);
  assert.equal(result.entries[0].path, root); assert.equal(result.readOnly, false);
}));

test('empty folders and single files report usable properties', () => fixture(async root => {
  const empty = await fileProperties([root]);
  assert.equal(empty.size, 0); assert.equal(empty.allocated, 0); assert.equal(empty.files, 0); assert.equal(empty.folders, 0);
  const file = path.join(root, 'one.txt'); await fs.writeFile(file, 'hello');
  const single = await fileProperties([file]);
  assert.equal(single.size, 5); assert.equal(single.files, 1); assert.equal(single.folders, 0);
  assert.equal(single.entries[0].isDirectory, false);
}));

test('overlapping and duplicate selections do not count a tree twice', () => fixture(async root => {
  await fs.mkdir(path.join(root, 'nested'));
  const child = path.join(root, 'nested/file'); await fs.writeFile(child, 'data');
  const result = await fileProperties([child, root, root, path.join(root, 'nested')]);
  assert.equal(result.size, 4); assert.equal(result.files, 1); assert.equal(result.folders, 1);
  assert.equal(result.entries.length, 3); assert.equal(result.readOnly, null);
}));

test('symlink cycles and external targets are not traversed', () => fixture(async root => {
  const folder = path.join(root, 'folder'); await fs.mkdir(folder);
  await fs.writeFile(path.join(root, 'external'), 'external target content');
  const links = [path.join(folder, 'cycle'), path.join(folder, 'external'), path.join(folder, 'broken')];
  await fs.symlink(folder, links[0]); await fs.symlink(path.join(root, 'external'), links[1]); await fs.symlink(path.join(root, 'missing'), links[2]);
  const stats = await Promise.all(links.map(link => fs.lstat(link)));
  const result = await fileProperties([folder]);
  assert.equal(result.size, stats.reduce((sum, stat) => sum + stat.size, 0));
  assert.equal(result.files, 3); assert.equal(result.symlinks, 3); assert.equal(result.folders, 0);
  const link = await fileProperties([links[0]]);
  assert.equal(link.symlinks, 1); assert.equal(link.folders, 0); assert.equal(link.size, stats[0].size);
}));

test('hard links share allocation and sparse files retain their logical size', () => fixture(async root => {
  const first = path.join(root, 'first'); await fs.writeFile(first, 'some data');
  await fs.link(first, path.join(root, 'second'));
  const handle = await fs.open(path.join(root, 'sparse'), 'w');
  try { await handle.truncate(64 * 1024 * 1024); } finally { await handle.close(); }
  const firstStat = await fs.lstat(first); const sparse = await fs.lstat(path.join(root, 'sparse'));
  const result = await fileProperties([root]);
  assert.equal(result.size, firstStat.size * 2 + sparse.size);
  assert.equal(result.allocated, (firstStat.blocks + sparse.blocks) * 512);
  assert.equal(result.files, 3); assert.ok(result.allocated < result.size);
}));

test('unreadable descendants produce partial totals, not a false complete result', { skip: process.getuid?.() === 0 }, () => fixture(async root => {
  await fs.mkdir(path.join(root, 'locked')); await fs.writeFile(path.join(root, 'locked/secret'), 'private');
  await fs.chmod(path.join(root, 'locked'), 0);
  const result = await fileProperties([root]);
  assert.equal(result.skipped, 1); assert.equal(result.folders, 1); assert.equal(result.files, 0);
  assert.equal((await fileProperties([path.join(root, 'locked')])).readOnly, true);
}));

test('invalid and missing roots fail; cancellation stops an active scan', () => fixture(async root => {
  await assert.rejects(fileProperties([]));
  await assert.rejects(fileProperties(['relative']), /绝对路径/);
  await assert.rejects(fileProperties([root + '\0']), /绝对路径/);
  await assert.rejects(fileProperties([path.join(root, 'missing')]), /ENOENT/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fileProperties([root], controller.signal), { name: 'AbortError' });
  const active = new AbortController();
  const scanning = fileProperties([root], active.signal);
  setImmediate(() => active.abort());
  await assert.rejects(scanning, { name: 'AbortError' });
}));
