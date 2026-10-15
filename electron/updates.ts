import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { t as tr } from '../shared/i18n';
import type { UpdateState } from '../shared/types';

// Unpacked updates contain app.asar, which Electron's patched fs treats as a virtual directory.
const fs: typeof nodeFs = process.versions.electron ? require('node:original-fs').promises : nodeFs;
const repository = 'https://github.com/qixiaoyu27/Mac-Explorer';
const latest = 'https://api.github.com/repos/qixiaoyu27/Mac-Explorer/releases/latest';
const exec = promisify(execFile);
const maxDownload = 2 * 1024 ** 3;
interface Release { version: string; archive: string; bytes: number }

export function compareVersions(a: string, b: string) {
  if (![a, b].every(value => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value))) throw new Error(tr('无法识别应用版本。'));
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function parseRelease(value: unknown): Release {
  const data = value as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; size: number; browser_download_url: string }[] } | null;
  const version = data?.tag_name?.replace(/^v/, '') || '';
  compareVersions(version, version);
  const archive = `Mac-Explorer-${version}-mac-arm64.zip`;
  if (data?.draft || data?.prerelease || !Array.isArray(data?.assets)) throw new Error(tr('最新发布信息不完整，请稍后重试。'));
  for (const name of [archive, 'SHA256SUMS.txt']) {
    const matches = data.assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || matches[0].browser_download_url !== `${repository}/releases/download/v${version}/${name}`) throw new Error(tr('最新发布信息不完整，请稍后重试。'));
  }
  const bytes = data.assets.find(asset => asset.name === archive)!.size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxDownload) throw new Error(tr('更新包大小无效。'));
  return { version, archive, bytes };
}
export function archiveChecksum(text: string, archive: string) {
  const matches = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2 && parts[1] === archive);
  if (matches.length !== 1 || !/^[a-f\d]{64}$/i.test(matches[0][0])) throw new Error(tr('更新校验文件无效。'));
  return matches[0][0].toLowerCase();
}
async function request(url: string, timeout = 20_000) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mac-Explorer' }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(tr('更新服务返回 HTTP {0}，请稍后重试。', response.status)); }
  return response;
}
async function* body(response: Response) {
  if (!response.body) throw new Error(tr('更新服务返回空响应。'));
  const reader = response.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; yield value; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function smallText(response: Response) {
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of body(response)) {
    text += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error(tr('更新服务响应过大。'));
  }
  return text + decoder.decode();
}

export class AppUpdates {
  state: UpdateState;
  private release?: Release;
  private directory?: string;
  private busy = false;
  private restored?: Promise<void>;
  constructor(private version: string, private cache: string, private appPath: string | undefined, private installer: string, private notify: (state: UpdateState) => void) {
    this.state = { currentVersion: version, status: 'idle', downloaded: 0, total: 0, canInstall: !!appPath };
  }
  async restore() {
    await (this.restored ??= (async () => {
      const directories = await fs.readdir(this.cache).catch(() => []);
      const results = await Promise.all(directories.filter(name => name.startsWith('download-')).map(async name => {
        const directory = path.join(this.cache, name);
        const stat = await fs.stat(path.join(directory, 'result')).catch(() => null);
        return stat ? { directory, time: stat.mtimeMs } : null;
      }));
      const last = results.filter(value => value !== null).sort((a, b) => b.time - a.time)[0];
      if (last && (await fs.readFile(path.join(last.directory, 'result'), 'utf8')).trim() !== '0' && this.state.status === 'idle') {
        this.set({ status: 'error', error: tr('上次更新未完成，请重试。') });
      }
      // Completed installers have already exited before the next app checks for updates.
      for (const result of results) if (result) {
        for (const file of await fs.readdir(result.directory)) if (file.endsWith('.zip') || file === 'verify') await fs.rm(path.join(result.directory, file), { recursive: true, force: true });
      }
    })());
    return this.state;
  }
  private set(value: Partial<UpdateState>) { this.state = { ...this.state, ...value }; this.notify(this.state); return this.state; }
  private async run(action: () => Promise<void>) {
    if (this.busy) return this.state;
    this.busy = true;
    try { await action(); }
    catch (error) { this.set({ status: 'error', error: tr('更新失败：{0}', error instanceof Error ? error.message : String(error)) }); }
    finally { this.busy = false; }
    return this.state;
  }
  check() {
    if (this.state.status === 'ready' || this.state.status === 'installing') return Promise.resolve(this.state);
    return this.run(async () => {
      await this.restore();
      this.set({ status: 'checking', error: undefined, latestVersion: undefined, downloaded: 0, total: 0 });
      this.release = undefined;
      const release = parseRelease(JSON.parse(await smallText(await request(latest))));
      this.release = release;
      this.set({ status: compareVersions(release.version, this.version) > 0 ? 'available' : 'current', latestVersion: release.version, total: release.bytes });
    });
  }
  download() {
    if (this.state.status === 'ready' || this.state.status === 'installing') return Promise.resolve(this.state);
    return this.run(async () => {
      const release = this.release;
      if (!release || compareVersions(release.version, this.version) <= 0) throw new Error(tr('请先检查更新。'));
      if (!this.appPath) throw new Error(tr('请在已安装的 Apple Silicon 版 Mac Explorer 中安装更新。'));
      await this.validateDestination();
      if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
      await fs.mkdir(this.cache, { recursive: true });
      const directory = this.directory = await fs.mkdtemp(path.join(this.cache, 'download-'));
      this.set({ status: 'downloading', downloaded: 0, total: release.bytes, error: undefined });
      try {
        const base = `${repository}/releases/download/v${release.version}`;
        const sums = await smallText(await request(`${base}/SHA256SUMS.txt`));
        const expected = archiveChecksum(sums, release.archive);
        const response = await request(`${base}/${release.archive}`, 15 * 60_000);
        const hash = createHash('sha256');
        const file = await fs.open(path.join(directory, release.archive), 'wx', 0o600);
        let downloaded = 0, lastProgress = 0;
        try {
          for await (const chunk of body(response)) {
            downloaded += chunk.byteLength;
            if (downloaded > release.bytes) throw new Error(tr('更新包大小不一致，请重新下载。'));
            hash.update(chunk); await file.writeFile(chunk);
            if (Date.now() - lastProgress > 150) { this.set({ downloaded }); lastProgress = Date.now(); }
          }
        } finally { await file.close(); }
        if (downloaded !== release.bytes || hash.digest('hex') !== expected) throw new Error(tr('更新包校验失败，请重新下载。'));
        this.set({ status: 'verifying', downloaded });
        await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), `${expected}  ${release.archive}\n`, { mode: 0o600 });
        await exec('/usr/bin/ditto', ['-x', '-k', path.join(directory, release.archive), path.join(directory, 'verify')], { timeout: 300_000 });
        const unpacked = path.join(directory, 'verify/Mac Explorer.app');
        if ((await fs.lstat(unpacked)).isSymbolicLink()) throw new Error(tr('更新应用无效。'));
        const plist = path.join(unpacked, 'Contents/Info.plist');
        const id = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', plist]);
        const version = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist]);
        if (id.stdout.trim() !== 'local.macexplorer.desktop' || version.stdout.trim() !== release.version) throw new Error(tr('更新应用标识或版本不匹配。'));
        await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', unpacked], { timeout: 120_000 });
        await fs.rm(path.join(directory, 'verify'), { recursive: true });
        await fs.copyFile(this.installer, path.join(directory, 'update-install.sh'));
        await fs.copyFile(path.join(path.dirname(this.installer), 'install.sh'), path.join(directory, 'install.sh'));
        this.set({ status: 'ready' });
      } catch (error) { await fs.rm(directory, { recursive: true, force: true }); this.directory = undefined; throw error; }
    });
  }
  private async validateDestination() {
    if (!this.appPath || path.basename(this.appPath) !== 'Mac Explorer.app' || (await fs.lstat(this.appPath)).isSymbolicLink() || await fs.realpath(this.appPath) !== this.appPath || this.appPath.startsWith('/Volumes/')) throw new Error(tr('请将 Mac Explorer 移到可写的应用程序目录后更新。'));
    await fs.access(path.dirname(this.appPath), fs.constants.W_OK);
    const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', path.join(this.appPath, 'Contents/Info.plist')]);
    if (stdout.trim() !== 'local.macexplorer.desktop') throw new Error(tr('更新应用无效。'));
  }
  async install(pid: number) {
    if (this.busy || this.state.status !== 'ready' || !this.directory || !this.appPath) throw new Error(tr('请先完成更新下载。'));
    this.busy = true;
    try {
      await this.validateDestination();
      const log = await fs.open(path.join(this.directory, 'install.log'), 'a', 0o600);
      try {
        const child = spawn('/bin/bash', [path.join(this.directory, 'update-install.sh')], { detached: true, stdio: ['ignore', log.fd, log.fd], env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          MAC_EXPLORER_INSTALL_DIR: path.dirname(this.appPath), MAC_EXPLORER_PREPARED_UPDATE: this.directory, MAC_EXPLORER_WAIT_PID: String(pid),
        } });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { await log.close(); }
      return this.set({ status: 'installing', error: undefined });
    } catch (error) { this.busy = false; throw error; }
  }
}
