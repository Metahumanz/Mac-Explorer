import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import nodeAPIHeaders from 'node-api-headers';
import { dropNativeFiles } from './native-file-drop.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-file-drag-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(path.join(docs, 'target'), { recursive: true });
const names = ['中文 空格 #%.txt', 'image.png'];
for (const name of names) await fs.writeFile(path.join(docs, name), 'fixture: ' + name);
const fixture = path.join(root, 'file-drag-fixture.node');
execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-DNAPI_VERSION=8', '-I', nodeAPIHeaders.include_dir, 'tests/fixtures/FileDragFixture.mm', '-o', fixture]);
execFileSync('codesign', ['--force', '--sign', '-', fixture]);
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const row = name => page.getByRole('option', { name, exact: true });
  await row(names[0]).waitFor();
  await app.evaluate(({}, fixture) => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    globalThis.fileDragFixture = require(fixture);
  }, fixture);
  const snapshot = () => app.evaluate(() => JSON.parse(globalThis.fileDragFixture.snapshot()));
  const waitForDrag = count => app.evaluate(async ({}, count) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.parse(globalThis.fileDragFixture.snapshot()).calls === count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Native drag was not started');
  }, count);
  const drag = async name => {
    const data = await page.evaluateHandle(() => new DataTransfer());
    try { await row(name).dispatchEvent('dragstart', { dataTransfer: data }); }
    finally { await data.dispose(); }
  };
  await drag(names[0]);
  await waitForDrag(1);
  let result = await snapshot();
  assert.equal(result.calls, 1);
  assert.deepEqual(result.items.map(item => fileURLToPath(item.url)), [path.join(docs, names[0])]);
  assert.ok(result.items.every(item => item.width > 0 && item.height > 0));
  assert.equal(result.outsideMask, 1, 'external drags must only copy, never move the source');
  await row(names[0]).click();
  await row(names[1]).click({ modifiers: ['Meta'] });
  await drag(names[1]);
  await waitForDrag(2);
  result = await snapshot(); assert.equal(result.calls, 2);
  assert.deepEqual(result.items.map(item => fileURLToPath(item.url)).sort(), names.map(name => path.join(docs, name)).sort());
  for (const name of names) assert.equal(await fs.readFile(path.join(docs, name), 'utf8'), 'fixture: ' + name);
  await drag('target');
  assert.equal((await snapshot()).calls, 2, 'folder pinning keeps the existing HTML drag');
  for (const input of [[], null, ['relative'], ['/tmp/a\0b'], [123], [path.join(docs, 'missing')]]) {
    await assert.rejects(page.evaluate(paths => window.explorer.startFileDrag(paths), input));
  }
  assert.equal((await snapshot()).calls, 2);
  // Chromium creates real File objects from this native file list; no app-specific text payload.
  await dropNativeFiles(page, names.map(name => path.join(docs, name)), row('target'));
  await row(names[0]).waitFor({ state: 'detached' });
  for (const name of names) {
    assert.equal(await fs.readFile(path.join(docs, 'target', name), 'utf8'), 'fixture: ' + name);
    await assert.rejects(fs.access(path.join(docs, name)));
  }
  await page.evaluate(() => window.explorer.undo());
  await row(names[0]).waitFor();
  for (const name of names) assert.equal(await fs.readFile(path.join(docs, name), 'utf8'), 'fixture: ' + name);
  assert.deepEqual(errors, []);
  console.log('PASS: native AppKit single/multiple file URLs, Unicode/space/#/% paths, nonempty drag icons, copy-only external payload; invalid/missing paths rejected; native File drop moves multiple files internally and undo restores. No chat files sent.');
} finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
