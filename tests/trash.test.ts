import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listTrash, recycleItem } from '../electron/trash';

test('iCloud recycle retries after a scoped folder selection and preserves files on cancellation or failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-cloud-trash-'));
  try {
    const cloud = path.join(root, 'iCloud'); const folder = path.join(cloud, 'folder');
    await fs.mkdir(folder, { recursive: true });
    const source = path.join(folder, '归档.zip'); await fs.writeFile(source, 'preserved');
    const denied = () => Object.assign(new Error('Denied'), { code: 'EACCES' });
    let calls = 0; let prompts = 0;
    const recycle = async () => { calls++; if (calls === 1) throw denied(); return '/trash/result'; };
    assert.equal(await recycleItem(source, cloud, recycle, async initial => { prompts++; assert.equal(initial, cloud); return cloud; }), '/trash/result');
    assert.equal(calls, 2); assert.equal(prompts, 1);
    calls = 0;
    assert.equal(await recycleItem(source, cloud, recycle, async () => folder), '/trash/result');
    const fail = async () => { throw denied(); };
    await assert.rejects(recycleItem(source, cloud, fail, async () => null), { code: 'ECANCELED' });
    await assert.rejects(recycleItem(source, cloud, fail, async () => root), /请选择/);
    await assert.rejects(recycleItem(source, cloud, fail, async () => cloud), { code: 'EACCES' });
    const noPrompt = async () => { assert.fail('Unrelated failures must not request iCloud access'); };
    await assert.rejects(recycleItem(path.join(root, 'local'), cloud, fail, noPrompt), { code: 'EACCES' });
    await assert.rejects(recycleItem(source, cloud, async () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); }, noPrompt), { code: 'ENOENT' });
    assert.equal(await fs.readFile(source, 'utf8'), 'preserved');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('trash browsing merges roots, preserves files and confines directory navigation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-trash-test-'));
  try {
    const home = path.join(root, '.Trash'); const external = path.join(root, 'external');
    await fs.mkdir(path.join(home, 'folder'), { recursive: true }); await fs.mkdir(external);
    await fs.writeFile(path.join(home, 'same.txt'), 'home'); await fs.writeFile(path.join(external, 'same.txt'), 'external');
    await fs.writeFile(path.join(home, 'folder', 'child.txt'), 'child');
    const roots = [home, external, path.join(root, 'missing')];
    assert.equal((await listTrash(roots)).entries.filter(e => e.name === 'same.txt').length, 2);
    assert.equal((await listTrash(roots, path.join(home, 'folder'))).entries[0].name, 'child.txt');
    await assert.rejects(listTrash(roots, root));
    await fs.symlink(root, path.join(home, 'escape'));
    await assert.rejects(listTrash(roots, path.join(home, 'escape')), /外部/);
    const invalid = path.join(root, 'not-a-directory'); await fs.writeFile(invalid, 'fixture');
    assert.deepEqual((await listTrash([...roots, invalid])).unavailable, [invalid]);
    assert.equal(await fs.readFile(path.join(home, 'same.txt'), 'utf8'), 'home');
    assert.equal(await fs.readFile(path.join(external, 'same.txt'), 'utf8'), 'external');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

import { TrashOrigins, snapshotTrash, emptyTrash, validateTrashItem } from '../electron/trash';

test('restore remembers origins across restarts, refuses collisions and supports an explicit destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-restore-test-'));
  try {
    const trash = path.join(root, '.Trash'); const destination = path.join(root, 'restored');
    await fs.mkdir(trash); await fs.mkdir(destination);
    const store = path.join(root, 'records'); const origins = new TrashOrigins(store);
    const source = path.join(trash, 'document.txt'); const original = path.join(root, 'document.txt');
    await fs.writeFile(source, 'original contents'); await origins.remember(source, original);
    await fs.writeFile(original, 'existing contents');
    assert.equal((await origins.restore([trash], [source])).errors.length, 1);
    assert.equal(await fs.readFile(original, 'utf8'), 'existing contents');
    assert.equal(await fs.readFile(source, 'utf8'), 'original contents');
    await fs.unlink(original);
    assert.equal((await new TrashOrigins(store).restore([trash], [source])).succeeded.length, 1);
    assert.equal(await fs.readFile(original, 'utf8'), 'original contents');
    await fs.writeFile(source, 'unknown origin');
    assert.equal((await origins.restore([trash], [source])).errors.length, 1);
    assert.equal((await origins.restore([trash], [source], destination)).succeeded.length, 1);
    assert.equal(await fs.readFile(path.join(destination, 'document.txt'), 'utf8'), 'unknown origin');
    const stale = path.join(trash, 'stale'); await fs.writeFile(stale, 'old'); await origins.remember(stale, path.join(root, 'old'));
    await fs.rename(stale, path.join(trash, 'moved')); await fs.writeFile(stale, 'replacement');
    assert.equal(await origins.original(stale), null);
    assert.equal((await origins.restore([trash], [original], destination)).errors.length, 1);
    assert.equal((await origins.restore([trash], [stale], trash)).errors.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('empty only deletes confirmed identities, unlinks symlinks and rejects outside paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-empty-test-'));
  try {
    const trash = path.join(root, '.Trash'); await fs.mkdir(trash);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep'), 'safe');
    await fs.symlink(outside, path.join(trash, 'link'));
    await fs.mkdir(path.join(trash, 'folder')); await fs.writeFile(path.join(trash, 'folder', 'child'), 'child');
    await fs.writeFile(path.join(trash, 'replaced'), 'old');
    await assert.rejects(validateTrashItem([trash], path.join(trash, 'link', 'keep')));
    await assert.rejects(validateTrashItem([trash], trash));
    const snapshot = await snapshotTrash([trash]);
    await fs.rename(path.join(trash, 'replaced'), path.join(root, 'old'));
    await fs.writeFile(path.join(trash, 'replaced'), 'new'); await fs.writeFile(path.join(trash, 'arrived'), 'new arrival');
    const result = await emptyTrash([trash], snapshot);
    assert.equal(result.succeeded.length, 2); assert.equal(result.errors.length, 1);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'safe');
    assert.equal(await fs.readFile(path.join(trash, 'replaced'), 'utf8'), 'new');
    assert.equal(await fs.readFile(path.join(trash, 'arrived'), 'utf8'), 'new arrival');
    const invalid = path.join(root, 'invalid'); await fs.writeFile(invalid, 'file');
    await assert.rejects(snapshotTrash([trash, invalid]), /无法读取/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
