import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-native-trash-')));
await fs.mkdir(path.join(root, 'Documents'));
const sibling = path.join(root, 'keep.txt');
await fs.writeFile(sibling, 'preserved');
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
let moved;
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  await page.locator('.file-content[aria-busy=false]').waitFor();
  const trash = input => app.evaluate(async ({ app }, input) => {
    const path = process.getBuiltinModule('path');
    const require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const native = require(path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'dist-electron/native/defaults.node'));
    return native.trashItem([input]);
  }, input);
  for (const name of ['含空格 & 引号“测试”.txt', 'folder', 'alias']) {
    const source = path.join(root, name);
    if (name === 'folder') { await fs.mkdir(source); await fs.writeFile(path.join(source, 'child.txt'), 'child'); }
    else if (name === 'alias') await fs.symlink(sibling, source);
    else await fs.writeFile(source, 'first contents');
    moved = await trash(source);
    assert.equal(await fs.lstat(source).catch(() => null), null);
    assert.equal((await fs.lstat(moved)).isSymbolicLink(), name === 'alias');
    assert.equal(await fs.readFile(sibling, 'utf8'), 'preserved');
    await fs.rename(moved, source); moved = undefined;
    if (name === 'folder') assert.equal(await fs.readFile(path.join(source, 'child.txt'), 'utf8'), 'child');
    else if (name !== 'alias') assert.equal(await fs.readFile(source, 'utf8'), 'first contents');
  }
  const collisions = [];
  try {
    for (const name of ['first', 'second']) {
      const source = path.join(root, name, 'same-name.txt');
      await fs.mkdir(path.dirname(source)); await fs.writeFile(source, name);
      const destination = await trash(source); collisions.push({ source, destination });
      assert.equal(await fs.readFile(destination, 'utf8'), name);
    }
    assert.notEqual(collisions[0].destination, collisions[1].destination);
    assert.equal(await fs.readFile(collisions[0].destination, 'utf8'), 'first');
  } finally {
    for (const item of collisions) await fs.rename(item.destination, item.source);
  }
  await assert.rejects(trash(path.join(root, 'missing')));
  await assert.rejects(app.evaluate(({ app }) => {
    const path = process.getBuiltinModule('path');
    const require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
    return require(path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'dist-electron/native/defaults.node')).trashItem(['relative']);
  }));
  console.log('PASS: real native recycle service, Unicode and special characters, folder contents, symlink target preservation, collision preservation, destination mapping and recovery, missing/invalid paths. Disposable temporary files only; every trashed item restored.');
} finally {
  await app.close();
  if (moved) console.error('Native trash fixture retained at:', moved);
  else await fs.rm(root, { recursive: true, force: true });
}
