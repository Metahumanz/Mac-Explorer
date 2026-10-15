import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { absolute } from './files';
import { t as tr } from '../shared/i18n';
import type { VcsAction, VcsChange, VcsDiff, VcsKind, VcsPlan, VcsResult, VcsState, VcsStatus } from '../shared/vcs';

const exec = promisify(execFile);
const rank: Record<VcsState, number> = { ignored: 0, clean: 1, untracked: 2, deleted: 3, added: 4, modified: 5, conflict: 6 };
type Repository = { root: string; kind: VcsKind };
type Snapshot = Repository & { branch: string; changes: VcsChange[]; tracked: string[]; signature: string };
type SavedPlan = { plan: VcsPlan; signature: string; expires: number };
const isInside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function canonicalXml(xml: string): string {
  // SVN does not guarantee attribute order between invocations.
  return xml.replace(/<([\w:-]+)\s+([^>]*?)(\/?)>/g, (_, name: string, attrs: string, close: string) => `<${name} ${(attrs.match(/[\w:-]+="[^"]*"/g) || []).sort().join(' ')}${close}>`);
}

export function parseGitStatus(output: string): { branch: string; changes: VcsChange[] } {
  const fields = output.split('\0');
  const changes: VcsChange[] = [];
  let branch = '';
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith('## ')) { branch = field.slice(3).replace(/^(No commits yet on |Initial commit on )/, '').split('...')[0]; continue; }
    if (field.length < 4 || field[2] !== ' ') throw new Error(tr('无法解析版本控制状态。'));
    const xy = field.slice(0, 2);
    const file = field.slice(3).replace(/\/$/, '');
    const state: VcsState = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy) ? 'conflict'
      : xy === '??' ? 'untracked' : xy === '!!' ? 'ignored' : xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : 'modified';
    changes.push({ path: file, state, staged: xy[0] !== ' ' && !['?', '!'].includes(xy[0]), unstaged: xy[1] !== ' ' && xy !== '!!' });
    if (xy.includes('R') || xy.includes('C')) {
      const old = fields[++index];
      if (!old) throw new Error(tr('无法解析版本控制状态。'));
      if (xy.includes('R')) changes.push({ path: old, state: 'deleted', staged: xy[0] === 'R', unstaged: xy[1] === 'R' });
    }
  }
  return { branch, changes };
}

function xmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity];
  });
}
function attribute(text: string, name: string): string { return xmlText(new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] || ''); }
export function parseSvnStatus(xml: string): { changes: VcsChange[]; tracked: string[] } {
  if (!xml.includes('<status>') || !xml.includes('</status>')) throw new Error(tr('无法解析版本控制状态。'));
  const changes: VcsChange[] = []; const tracked: string[] = [];
  for (const match of xml.matchAll(/<entry\s+([^>]+)>([\s\S]*?)<\/entry>/g)) {
    const name = attribute(match[1], 'path');
    const status = /<wc-status\s+([^>]+)>/.exec(match[2])?.[1] || /<wc-status\s+([^>]+)\/>/.exec(match[2])?.[1];
    if (!name || !status) throw new Error(tr('无法解析版本控制状态。'));
    const item = attribute(status, 'item'); const props = attribute(status, 'props');
    if (!['normal', 'none', 'conflicted', 'unversioned', 'ignored', 'external', 'added', 'deleted', 'missing', 'modified', 'replaced', 'obstructed', 'incomplete'].includes(item)) throw new Error(tr('无法解析版本控制状态。'));
    if (item === 'external') continue;
    const state: VcsState = item === 'conflicted' || props === 'conflicted' || attribute(status, 'tree-conflicted') === 'true' ? 'conflict'
      : item === 'unversioned' || item === 'none' ? 'untracked' : item === 'ignored' ? 'ignored'
      : item === 'added' ? 'added' : item === 'deleted' || item === 'missing' ? 'deleted'
      : ['modified', 'replaced', 'obstructed', 'incomplete'].includes(item) || props === 'modified' ? 'modified' : 'clean';
    if (state !== 'untracked' && state !== 'ignored') tracked.push(name);
    if (state !== 'clean') changes.push({ path: name, state, staged: false, unstaged: true });
  }
  return { changes, tracked };
}

export class VersionControl {
  private enabled = true;
  private reads = new Set<AbortController>();
  private cache = new Map<string, { expires: number; pending: Promise<Snapshot> }>();
  private plans = new Map<string, SavedPlan>();
  private busy = new Set<string>();
  constructor(private backupDirectory: string) {}

  setEnabled(value: boolean) {
    this.enabled = value; this.cache.clear(); this.plans.clear();
    for (const read of this.reads) read.abort();
    this.reads.clear();
  }
  private requireEnabled() { if (!this.enabled) throw new Error(tr('版本控制集成已关闭。')); }
  private async tool(kind: VcsKind): Promise<string> {
    const dirs = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(process.env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p))])];
    for (const directory of dirs) {
      const file = path.join(directory, kind);
      if (await fs.access(file, constants.X_OK).then(() => true, () => false)) return file;
    }
    throw new Error(tr('未找到 {0} 命令行工具，请先安装后刷新。', kind === 'git' ? 'Git' : 'SVN'));
  }
  private async command(repo: Repository, args: string[], writing = false): Promise<string> {
    this.requireEnabled();
    const tool = await this.tool(repo.kind);
    this.requireEnabled();
    const controller = new AbortController();
    if (!writing) this.reads.add(controller);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { LC_ALL: 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10' });
    try {
      const result = await exec(tool, repo.kind === 'git' ? ['-c', 'core.fsmonitor=false', ...args] : ['--non-interactive', ...args], {
        cwd: repo.root, env, encoding: 'utf8', timeout: writing ? 120_000 : 8_000, maxBuffer: 4 * 1024 * 1024,
        ...(writing ? {} : { signal: controller.signal }),
      });
      return result.stdout;
    } catch (error) {
      const e = error as Error & { stderr?: string; killed?: boolean; code?: string | number };
      if (e.killed || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(tr('版本控制查询超时或结果过大，请在终端处理此仓库。'));
      if (e.name === 'AbortError') throw e;
      throw new Error((e.stderr || e.message).slice(0, 3000));
    } finally { this.reads.delete(controller); }
  }
  private async repository(input: string): Promise<Repository | null> {
    this.requireEnabled();
    let directory = await fs.realpath(absolute(input));
    if (directory.split(path.sep).some(part => part === '.git' || part === '.svn')) return null;
    if (!(await fs.stat(directory)).isDirectory()) throw new Error(tr('需要有效的仓库文件夹。'));
    while (true) {
      for (const kind of ['git', 'svn'] as const) {
        if (await fs.lstat(path.join(directory, kind === 'git' ? '.git' : '.svn')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return { root: directory, kind };
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  private async snapshot(repo: Repository, force = false): Promise<Snapshot> {
    const cached = this.cache.get(repo.root);
    if (cached && (!force || cached.expires === Infinity) && cached.expires > Date.now()) return cached.pending;
    const pending = (async () => {
      if (repo.kind === 'git') {
        const raw = await this.command(repo, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']);
        const parsed = parseGitStatus(raw);
        const tracked = (await this.command(repo, ['ls-files', '--cached', '-z'])).split('\0').filter(Boolean);
        if (parsed.changes.length > 5000 || tracked.length > 100_000) throw new Error(tr('版本控制查询超时或结果过大，请在终端处理此仓库。'));
        return { ...repo, ...parsed, tracked, signature: digest(raw) };
      }
      const raw = await this.command(repo, ['status', '--xml', '--verbose', '--no-ignore', '--ignore-externals', '.']);
      const parsed = parseSvnStatus(raw);
      if (parsed.changes.length > 5000 || parsed.tracked.length > 100_000) throw new Error(tr('版本控制查询超时或结果过大，请在终端处理此仓库。'));
      return { ...repo, ...parsed, branch: '', signature: digest(canonicalXml(raw)) };
    })();
    const entry = { expires: Infinity, pending };
    this.cache.set(repo.root, entry);
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
    try { const result = await pending; entry.expires = Date.now() + 2000; return result; }
    catch (error) { if (this.cache.get(repo.root) === entry) this.cache.delete(repo.root); throw error; }
  }
  async status(input: string, force = false): Promise<VcsStatus | null> {
    if (!this.enabled) return null;
    const requested = absolute(input);
    const directory = await fs.realpath(requested);
    const repo = await this.repository(directory);
    if (!repo) return null;
    try {
      const snapshot = await this.snapshot(repo, force);
      const states: Record<string, VcsState> = {};
      const apply = (file: string, state: VcsState) => {
        const full = path.resolve(repo.root, file);
        if (!isInside(directory, full) || full === directory) return;
        const child = path.join(requested, path.relative(directory, full).split(path.sep)[0]);
        if (!states[child] || rank[state] > rank[states[child]]) states[child] = state;
      };
      for (const file of snapshot.tracked) apply(file, 'clean');
      for (const change of snapshot.changes) apply(change.path, change.state);
      if (snapshot.changes.some(change => change.state === 'ignored' && isInside(path.resolve(repo.root, change.path), directory))) {
        for (const name of await fs.readdir(directory)) if (name !== '.git' && name !== '.svn') states[path.join(requested, name)] ??= 'ignored';
      }
      return { ...repo, branch: snapshot.branch, states };
    } catch (error) {
      return { ...repo, branch: '', states: {}, error: (error as Error).message };
    }
  }
  private async targets(repo: Repository, values: unknown): Promise<string[]> {
    if (!Array.isArray(values) || !values.length || values.length > 5000) throw new Error(tr('无效的版本控制文件选择。'));
    const result: string[] = [];
    for (const value of values) {
      const requested = absolute(value);
      let parent = path.dirname(requested);
      while (!(await fs.lstat(parent).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))) parent = path.dirname(parent);
      const real = await fs.realpath(parent);
      let file = path.resolve(real, path.relative(parent, requested));
      if (!isInside(repo.root, file) && await fs.realpath(requested).catch(() => '') === repo.root) file = repo.root;
      const relative = path.relative(repo.root, file);
      if (!isInside(repo.root, file) || relative.split(path.sep).some(p => p === '.git' || p === '.svn')) throw new Error(tr('文件必须位于同一仓库内。'));
      if (file === repo.root) { result.push('.'); continue; }
      const owner = await this.repository(real);
      if (!isInside(repo.root, real) || owner?.root !== repo.root || owner.kind !== repo.kind) throw new Error(tr('文件必须位于同一仓库内。'));
      if (file !== repo.root && await fs.lstat(file).then(s => s.isDirectory(), () => false)) {
        const child = await this.repository(file);
        if (child?.root !== repo.root) throw new Error(tr('请进入子仓库后操作。'));
      }
      result.push(relative || '.');
    }
    return [...new Set(result)];
  }
  private svnPaths(files: string[]) { return files.map(file => file + '@'); }
  private selected(change: VcsChange, files: string[]) { return files.some(file => file === '.' || change.path === file || change.path.startsWith(file + '/')); }
  private async conflictFiles(repo: Repository, changes: VcsChange[]): Promise<string[]> {
    const conflicts = changes.filter(change => change.state === 'conflict');
    if (repo.kind !== 'svn' || !conflicts.length) return [];
    const info = await this.command(repo, ['info', '--xml', '--', ...this.svnPaths(conflicts.map(change => change.path))]);
    const files: string[] = [];
    for (const match of info.matchAll(/<(prev-base-file|prev-wc-file|cur-base-file|prop-file)>([^<]+)<\/\1>/g)) {
      const full = absolute(xmlText(match[2]));
      await this.targets(repo, [full]);
      files.push(path.relative(repo.root, full));
    }
    return files;
  }
  private async checkAddedDirectory(repo: Repository, file: string) {
    const pending = [path.resolve(repo.root, file)]; let count = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      if (!(await fs.lstat(directory)).isDirectory()) continue;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      if (entries.some(entry => entry.name === '.git' || entry.name === '.svn')) throw new Error(tr('请进入子仓库后操作。'));
      for (const entry of entries) {
        if (++count > 5000) throw new Error(tr('版本控制查询超时或结果过大，请在终端处理此仓库。'));
        if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      }
    }
  }
  async diff(input: string, values: string[]): Promise<VcsDiff> {
    const repo = await this.repository(input);
    if (!repo) throw new Error(tr('此位置不属于版本控制仓库。'));
    const files = await this.targets(repo, values);
    if (repo.kind === 'svn') return { working: await this.command(repo, ['diff', '--internal-diff', '--', ...files]), staged: '' };
    return { working: await this.command(repo, ['diff', '--no-ext-diff', '--no-textconv', '--', ...files]), staged: await this.command(repo, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...files]) };
  }
  private async signature(repo: Repository, changes: VcsChange[], action: VcsAction, snapshot: Snapshot): Promise<string> {
    const hash = createHash('sha256').update(snapshot.signature);
    if (repo.kind === 'git') {
      hash.update(await this.command(repo, ['ls-files', '--stage', '-z']));
      hash.update(await this.command(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => 'unborn'));
    }
    if (repo.kind === 'svn' && ['commit', 'revert'].includes(action)) hash.update(canonicalXml(await this.command(repo, ['proplist', '--xml', '--verbose', '--', ...this.svnPaths(changes.map(change => change.path))])));
    if (action === 'revert' || repo.kind === 'svn' && action === 'commit') for (const relative of [...changes.map(change => change.path), ...(action === 'revert' ? await this.conflictFiles(repo, changes) : [])]) {
      const file = path.resolve(repo.root, relative);
      const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const contentHash = createHash('sha256');
      if (stat?.isSymbolicLink()) contentHash.update(await fs.readlink(file));
      else if (stat?.isFile()) for await (const chunk of createReadStream(file)) contentHash.update(chunk);
      else contentHash.update(stat ? 'directory' : 'missing');
      hash.update(JSON.stringify([relative, stat?.mode, contentHash.digest('hex')]));
    }
    return hash.digest('hex');
  }
  async prepare(input: string, action: VcsAction, values: string[]): Promise<VcsPlan> {
    if (!['add', 'commit', 'update', 'revert'].includes(action)) throw new Error(tr('无效的版本控制操作。'));
    const repo = await this.repository(input);
    if (!repo) throw new Error(tr('此位置不属于版本控制仓库。'));
    const files = await this.targets(repo, values);
    const snapshot = await this.snapshot(repo, true);
    let changes = snapshot.changes.filter(change => this.selected(change, files));
    if (action === 'commit' && repo.kind === 'git') changes = snapshot.changes.filter(change => change.staged);
    if (action === 'revert') changes = changes.filter(change => change.unstaged && !['untracked', 'ignored'].includes(change.state));
    if (action === 'add') changes = changes.filter(change => change.state !== 'ignored' && (repo.kind === 'git' ? change.unstaged : change.state === 'untracked'));
    if (action === 'commit' && repo.kind === 'svn') changes = changes.filter(change => !['untracked', 'ignored'].includes(change.state));
    if (action !== 'update' && !changes.length) throw new Error(tr('没有可执行此操作的更改。'));
    if (action !== 'revert' && snapshot.changes.some(change => change.state === 'conflict')) throw new Error(tr('仓库存在冲突，请先在终端或版本控制工具中解决。'));
    if (action === 'update') {
      if (snapshot.changes.some(change => change.state !== 'ignored')) throw new Error(tr('请先提交或保存本地更改，再更新仓库。'));
      changes = [];
    }
    for (const change of changes) await this.targets(repo, [path.resolve(repo.root, change.path)]);
    if (repo.kind === 'svn' && action === 'add') for (const change of changes) await this.checkAddedDirectory(repo, change.path);
    const plan: VcsPlan = { id: randomUUID(), ...repo, action, changes };
    const signature = await this.signature(repo, changes, action, snapshot);
    for (const [id, saved] of this.plans) if (saved.expires < Date.now()) this.plans.delete(id);
    while (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.id, { plan, signature, expires: Date.now() + 5 * 60_000 });
    return plan;
  }
  private async backup(plan: VcsPlan): Promise<string> {
    const directory = path.join(this.backupDirectory, plan.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest: { path: string; exists: boolean }[] = [];
    for (const relative of [...new Set([...plan.changes.map(change => change.path), ...await this.conflictFiles(plan, plan.changes)])]) {
      const source = path.resolve(plan.root, relative);
      await this.targets(plan, [source]);
      const stat = await fs.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      manifest.push({ path: relative, exists: !!stat });
      if (!stat) continue;
      const destination = path.join(directory, 'files', relative);
      if (stat.isDirectory()) await fs.mkdir(destination, { recursive: true });
      else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(source, destination, { dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
      }
    }
    if (plan.kind === 'svn') {
      await fs.writeFile(path.join(directory, 'properties.xml'), await this.command(plan, ['proplist', '--xml', '--verbose', '--', ...this.svnPaths(plan.changes.map(change => change.path))]), { mode: 0o600 });
      await fs.writeFile(path.join(directory, 'changes.patch'), await this.command(plan, ['diff', '--internal-diff', '--', ...plan.changes.map(change => change.path)]), { mode: 0o600 });
    }
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ root: plan.root, kind: plan.kind, created: new Date().toISOString(), files: manifest }, null, 2), { mode: 0o600 });
    return directory;
  }
  async execute(id: string, message: string): Promise<VcsResult> {
    this.requireEnabled();
    const saved = this.plans.get(id);
    if (!saved || saved.expires < Date.now()) throw new Error(tr('操作预览已失效，请重新打开。'));
    const { plan } = saved;
    if (typeof message !== 'string' || message.length > 10_000 || message.includes('\0') || plan.action === 'commit' && !message.trim()) throw new Error(tr('请填写有效的提交信息。'));
    if (this.busy.has(plan.root)) throw new Error(tr('此仓库正在执行其他操作，请稍后重试。'));
    this.plans.delete(id); this.busy.add(plan.root);
    let backup: string | undefined;
    try {
      const repo = await this.repository(plan.root);
      if (!repo || repo.root !== plan.root || repo.kind !== plan.kind) throw new Error(tr('操作预览已失效，请重新打开。'));
      for (const change of plan.changes) await this.targets(repo, [path.resolve(repo.root, change.path)]);
      const snapshot = await this.snapshot(repo, true);
      if (await this.signature(repo, plan.changes, plan.action, snapshot) !== saved.signature) throw new Error(tr('仓库已发生变化，请重新预览后再操作。'));
      const files = plan.changes.map(change => change.path);
      if (plan.kind === 'svn' && plan.action === 'add') for (const file of files) await this.checkAddedDirectory(repo, file);
      if (plan.action === 'revert') backup = await this.backup(plan);
      if (backup && await this.signature(repo, plan.changes, plan.action, await this.snapshot(repo, true)) !== saved.signature) throw new Error(tr('仓库已发生变化，请重新预览后再操作。'));
      let args: string[];
      if (plan.kind === 'git') args = plan.action === 'commit' ? ['commit', '-m', message]
        : plan.action === 'update' ? ['pull', '--ff-only', '--no-rebase']
        : plan.action === 'add' ? ['add', '--', ...files] : ['restore', '--worktree', '--', ...files];
      else args = plan.action === 'commit' ? ['commit', '-m', message, '--', ...this.svnPaths(files)]
        : plan.action === 'update' ? ['update', '--accept', 'postpone', '--ignore-externals', '--', '.@']
        : plan.action === 'add' ? ['add', '--parents', '--', ...this.svnPaths(files)]
        : ['revert', '--depth', 'empty', '--', ...this.svnPaths([...files].sort((a, b) => b.split('/').length - a.split('/').length))];
      return { output: await this.command(repo, args, true), backup };
    } catch (error) {
      throw new Error((error as Error).message + (backup ? '\n' + tr('修改前的文件备份保存在：{0}', backup) : ''));
    } finally { this.busy.delete(plan.root); this.cache.delete(plan.root); }
  }
}
