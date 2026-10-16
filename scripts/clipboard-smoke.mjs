import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-clipboard-')));
const docs = path.join(root, 'Documents');
const source = path.join(root, 'Source');
await fs.mkdir(docs); await fs.mkdir(source);
const files = ['one.txt', '中文 空格#%.txt', '换行\n文件.txt'];
for (const name of files) await fs.writeFile(path.join(source, name), `content: ${name}`);
await fs.mkdir(path.join(source, '资料'));
await fs.writeFile(path.join(source, '资料/nested.txt'), 'nested content');
const sources = [...files, '资料'].map(name => path.join(source, name));
const rawType = 'electron application/osclipboard;format="public.file-url"';
const ownType = 'electron application/osclipboard;format="local.macexplorer.files"';
let app;
try {
  app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.file-content[aria-busy="false"]').waitFor();
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  const read = () => page.evaluate(() => window.explorer.clipboardGet());
  const write = values => app.evaluate(async ({ clipboard, ClipboardItem }, values) => {
    await clipboard.write([new ClipboardItem(values)]);
    return (await clipboard.read()).flatMap(item => item.types);
  }, values);
  const urls = sources.map(file => pathToFileURL(file).href);
  const formats = await write({ 'text/uri-list': urls[0] });
  assert.ok(formats.includes('text/uri-list'));
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '', 'Native files must work without a plain-text fallback');
  assert.deepEqual(await read(), { paths: [sources[0]], cut: false });
  await write({ 'text/uri-list': [...urls, urls[0]].join('\r\n') });
  assert.deepEqual(await read(), { paths: sources, cut: false });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: '粘贴 (⌘V)', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('button[aria-label="粘贴 (⌘V)"]:not(:disabled)'));
  await page.keyboard.press('Meta+v');
  await page.waitForFunction(() => document.querySelector('.status-feedback')?.textContent.includes('已粘贴 4 个项目'));
  for (const name of files) {
    assert.equal(await fs.readFile(path.join(docs, name), 'utf8'), `content: ${name}`);
    assert.equal(await fs.readFile(path.join(source, name), 'utf8'), `content: ${name}`);
  }
  assert.equal(await fs.readFile(path.join(docs, '资料/nested.txt'), 'utf8'), 'nested content');
  assert.equal(await fs.readFile(path.join(source, '资料/nested.txt'), 'utf8'), 'nested content');
  await fs.writeFile(path.join(docs, files[0]), 'keep destination edit');
  const collision = await page.evaluate(directory => window.explorer.paste(directory), docs);
  assert.equal(collision.succeeded.length, 0); assert.equal(collision.errors.length, 4);
  assert.equal(await fs.readFile(path.join(docs, files[0]), 'utf8'), 'keep destination edit');
  const missing = path.join(source, 'missing.txt');
  await write({ 'text/uri-list': [pathToFileURL(missing).href, pathToFileURL(path.join(source, 'available.txt')).href].join('\n') });
  await fs.writeFile(path.join(source, 'available.txt'), 'available content');
  const partial = await page.evaluate(directory => window.explorer.paste(directory), docs);
  assert.equal(partial.errors.length, 1); assert.equal(partial.succeeded.length, 1);
  assert.equal(await fs.readFile(path.join(docs, 'available.txt'), 'utf8'), 'available content');
  await write({ [ownType]: 'corrupt metadata', 'text/uri-list': urls.join('\n') });
  assert.deepEqual(await read(), { paths: sources, cut: false });
  await write({ [rawType]: urls[0] });
  assert.deepEqual(await read(), { paths: [sources[0]], cut: false });
  await write({ 'text/plain': urls.join('\n') });
  assert.deepEqual(await read(), { paths: sources, cut: false });
  for (const text of ['plain text', 'https://example.com/file.txt', 'file://remote-host/invalid', 'file:///bad%00name']) {
    await write({ 'text/plain': text });
    const clip = await read();
    if (text === 'file:///bad%00name') await assert.rejects(page.evaluate(directory => window.explorer.paste(directory), docs), /有效的绝对路径/);
    else assert.deepEqual(clip, { paths: [], cut: false });
  }
  await app.evaluate(({ clipboard }) => clipboard.clear());
  assert.deepEqual(await read(), { paths: [], cut: false });
  const empty = await page.evaluate(directory => window.explorer.paste(directory), docs);
  assert.deepEqual(empty.succeeded, []); assert.deepEqual(empty.errors, []);
  await page.evaluate(paths => window.explorer.clipboardSet(paths, true), sources);
  assert.deepEqual(await read(), { paths: sources, cut: true });
  await page.evaluate(paths => window.explorer.clipboardSet(paths, false), sources);
  assert.deepEqual(await read(), { paths: sources, cut: false });
  assert.deepEqual(errors, []);
  console.log('PASS: real OS text/uri-list without plain text; single/multiple files, folders, CRLF/LF, Unicode, spaces, percent/hash/newline names, duplicate paths, Command+V, preserved sources, collisions and partial failure; corrupt metadata, legacy URLs, text fallback, empty clipboard and internal cut/copy. Native-format fixtures; no Finder/WeChat UI interaction.');
} finally {
  if (app) {
    await app.evaluate(async ({ clipboard }) => { if (globalThis.savedClipboard?.length) await clipboard.write(globalThis.savedClipboard); else clipboard.clear(); }).catch(() => {});
    await app.close();
  }
  await fs.rm(root, { recursive: true, force: true });
}
