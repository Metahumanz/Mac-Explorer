import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-updater-asar-')));
let app;
try {
  await fs.mkdir(path.join(root, 'Documents'));
  const source = path.join(root, 'source/Mac Explorer.app');
  await fs.mkdir(path.join(source, 'Contents/MacOS'), { recursive: true });
  await fs.mkdir(path.join(source, 'Contents/Resources'));
  const content = path.join(root, 'asar-content'); await fs.mkdir(content);
  await fs.writeFile(path.join(content, 'package.json'), '{"name":"updater-fixture"}');
  await createPackage(content, path.join(source, 'Contents/Resources/app.asar'));
  await fs.copyFile('/usr/bin/true', path.join(source, 'Contents/MacOS/Mac Explorer'));
  await fs.writeFile(path.join(source, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.macexplorer.desktop</string><key>CFBundleVersion</key><string>0.1.999</string><key>CFBundleShortVersionString</key><string>0.1.999</string><key>CFBundleExecutable</key><string>Mac Explorer</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', source], { stdio: 'pipe' });
  const archive = 'Mac-Explorer-0.1.999-mac-arm64.zip';
  const zipPath = path.join(root, archive);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, zipPath]);
  const zip = await fs.readFile(zipPath);
  const target = path.join(root, 'Applications/Mac Explorer.app');
  await fs.mkdir(path.dirname(target)); await fs.cp(source, target, { recursive: true });
  const before = await fs.readFile(path.join(target, 'Contents/Resources/app.asar'));
  const module = path.join(root, 'updates.cjs');
  await build({ entryPoints: ['electron/updates.ts'], outfile: module, bundle: true, platform: 'node', format: 'cjs' });
  app = await electron.launch({ args: [process.cwd()], env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
  const page = await app.firstWindow(); await page.locator('.file-content[aria-busy="false"]').waitFor();
  const result = await app.evaluate(async ({}, { module, target, root, archive, checksum, base64, installer }) => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    const { AppUpdates } = require(module);
    const disk = require('node:original-fs').promises;
    globalThis.fetch = async url => {
      if (String(url).endsWith('/latest')) return Response.json({ tag_name: 'v0.1.999', assets: [archive, 'SHA256SUMS.txt'].map(name => ({ name, size: Buffer.from(base64, 'base64').length, browser_download_url: `https://github.com/qixiaoyu27/Mac-Explorer/releases/download/v0.1.999/${name}` })) });
      if (String(url).endsWith('SHA256SUMS.txt')) return new Response(`${checksum}  ${archive}\n`);
      return new Response(Buffer.from(base64, 'base64'));
    };
    const cache = root + '/cache';
    const updates = new AppUpdates('0.1.50', cache, target, installer, () => {});
    await updates.check();
    const state = await updates.download();
    if (state.status !== 'ready') return { state };
    const directory = cache + '/' + (await disk.readdir(cache))[0];
    const removed = await disk.stat(directory + '/verify').then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true; });
    await disk.copyFile(installer, directory + '/update-install.sh');
    // Completed-download cleanup also traverses an app.asar tree in the real Electron runtime.
    await disk.cp(target, directory + '/verify/Mac Explorer.app', { recursive: true });
    await disk.writeFile(directory + '/result', '0');
    const restarted = new AppUpdates('0.1.999', cache, target, installer, () => {});
    await restarted.restore();
    const cleaned = await disk.stat(directory + '/verify').then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true; });
    return { state, removed, cleaned };
  }, { module, target, root, archive, checksum: createHash('sha256').update(zip).digest('hex'), base64: zip.toString('base64'), installer: path.resolve('scripts/update-install.sh') });
  assert.equal(result.state.status, 'ready', JSON.stringify(result.state));
  assert.equal(result.removed, true); assert.equal(result.cleaned, true);
  assert.deepEqual(await fs.readFile(path.join(target, 'Contents/Resources/app.asar')), before);
  console.log('PASS: real Electron updater downloads and verifies a signed ASAR-containing app, removes its verification tree, cleans completed updates, and preserves the installed app. HTTP responses use fixture bytes; no real app installed.');
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
