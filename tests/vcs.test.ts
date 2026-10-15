import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VersionControl, parseGitStatus, parseSvnStatus } from '../electron/vcs';

const exec = promisify(execFile);
async function git(root: string, ...args: string[]) { return (await exec('/usr/bin/git', ['-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' })).stdout; }
async function fixture(run: (root: string, service: VersionControl) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-vcs-')));
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-vcs-backups-'));
  const service = new VersionControl(backup);
  try {
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', '文件 name.txt'), 'original\n');
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\nsrc/cache/\n');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'fixture');
    await run(root, service);
  } finally { service.setEnabled(false); await fs.rm(root, { recursive: true, force: true }); await fs.rm(backup, { recursive: true, force: true }); }
}

test('Git porcelain handles NUL paths, both status columns, conflicts and rename source paths', () => {
  const result = parseGitStatus('## main...origin/main\0MM 中文\nname.txt\0R  new.txt\0old.txt\0?? -file\0!! ignored\0UU conflict\0');
  assert.equal(result.branch, 'main');
  assert.deepEqual(result.changes[0], { path: '中文\nname.txt', state: 'modified', staged: true, unstaged: true });
  assert.equal(result.changes.find(c => c.path === 'old.txt')?.state, 'deleted');
  assert.equal(result.changes.at(-1)?.state, 'conflict');
  assert.throws(() => parseGitStatus('R  new\0'));
});
test('SVN XML includes property and tree conflicts, ignored items and escaped filenames', () => {
  const result = parseSvnStatus('<status><target path="."><entry path="a&amp;&quot;&apos;&#10;中"><wc-status item="normal" props="modified" revision="1"></wc-status></entry><entry path="tree"><wc-status item="normal" props="none" tree-conflicted="true"/></entry><entry path="ignored"><wc-status item="ignored" props="none"/></entry></target></status>');
  assert.equal(result.changes[0].path, "a&\"'\n中");
  assert.equal(result.changes[0].state, 'modified'); assert.equal(result.changes[1].state, 'conflict');
  assert.deepEqual(result.tracked, [result.changes[0].path, 'tree']);
  assert.throws(() => parseSvnStatus('<status>broken'));
});
test('ordinary directories and a disabled service do not run version control commands', () => fixture(async (root, service) => {
  let calls = 0;
  const command = Reflect.get(service, 'command').bind(service);
  Reflect.set(service, 'command', (...args: unknown[]) => { calls++; return command(...args); });
  const ordinary = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-ordinary-'));
  try { assert.equal(await service.status(ordinary), null); assert.equal(calls, 0); }
  finally { await fs.rm(ordinary, { recursive: true, force: true }); }
  service.setEnabled(false); assert.equal(await service.status(root), null); assert.equal(calls, 0);
  await assert.rejects(service.prepare(root, 'update', [root]), /已关闭/);
}));
test('status maps clean, modified, ignored and untracked states and aggregates folders', () => fixture(async (root, service) => {
  await fs.writeFile(path.join(root, 'src', '文件 name.txt'), 'changed\n');
  await fs.mkdir(path.join(root, 'src', 'cache')); await fs.writeFile(path.join(root, 'src', 'cache', 'a'), 'ignored');
  await fs.mkdir(path.join(root, 'ignored')); await fs.writeFile(path.join(root, 'ignored', 'a'), 'ignored');
  await fs.writeFile(path.join(root, 'new\n中文.txt'), 'new');
  const status = await service.status(root);
  assert.ok(status && !status.error); assert.equal(status.branch, 'main');
  assert.equal(status.states[path.join(root, 'src')], 'modified');
  assert.equal(status.states[path.join(root, '.gitignore')], 'clean');
  assert.equal(status.states[path.join(root, 'ignored')], 'ignored');
  assert.equal(status.states[path.join(root, 'new\n中文.txt')], 'untracked');
  const child = await service.status(path.join(root, 'src'));
  assert.equal(child?.root, root); assert.equal(child?.states[path.join(root, 'src', '文件 name.txt')], 'modified');
  assert.equal(child?.states[path.join(root, 'src', 'cache')], 'ignored');
  assert.equal((await service.status(path.join(root, 'ignored')))?.states[path.join(root, 'ignored', 'a')], 'ignored');
  assert.equal(await service.status(path.join(root, '.git')), null);
}));
test('concurrent status requests share one scan and force refresh observes external modifications', () => fixture(async (root, service) => {
  let calls = 0;
  const command = Reflect.get(service, 'command').bind(service);
  Reflect.set(service, 'command', (...args: unknown[]) => { calls++; return command(...args); });
  await Promise.all([service.status(root), service.status(root), service.status(path.join(root, 'src'))]);
  assert.equal(calls, 2);
  await fs.writeFile(path.join(root, 'src', '文件 name.txt'), 'external');
  assert.equal((await service.status(root, true))?.states[path.join(root, 'src')], 'modified');
}));
test('turning integration off aborts an actual pending status process and clears its cache', () => fixture(async (root, service) => {
  const helper = path.join(root, 'slow-cli');
  await fs.writeFile(helper, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`, { mode: 0o700 });
  Reflect.set(service, 'tool', async () => helper);
  const pending = service.status(root);
  const reads = Reflect.get(service, 'reads') as Set<AbortController>;
  for (let attempt = 0; !reads.size && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(reads.size); const controller = [...reads][0]; service.setEnabled(false);
  assert.equal(controller.signal.aborted, true); await pending;
  assert.equal(await service.status(root), null); assert.equal(Reflect.get(service, 'cache').size, 0);
}));
test('missing command line tools produce an explicit error without clean badges', () => fixture(async (root, service) => {
  Reflect.set(service, 'tool', async () => { throw new Error('fixture missing tool'); });
  const status = await service.status(root); assert.match(status?.error || '', /missing tool/); assert.deepEqual(status?.states, {});
}));
test('Git worktrees and nested repositories resolve their own roots', () => fixture(async (root, service) => {
  const worktree = root + '-worktree';
  try {
    await git(root, 'worktree', 'add', '-b', 'other', worktree);
    assert.equal((await service.status(path.join(worktree, 'src')))?.root, worktree);
    assert.equal((await service.status(worktree))?.branch, 'other');
    const nested = path.join(root, 'nested'); await fs.mkdir(nested); await git(nested, 'init', '-b', 'nested');
    assert.equal((await service.status(nested))?.root, nested);
    await assert.rejects(service.prepare(root, 'add', [nested]), /子仓库|同一仓库/);
  } finally { await git(root, 'worktree', 'remove', '--force', worktree).catch(() => {}); }
}));
test('status and operations accept macOS path aliases without escaping the repository', () => fixture(async (root, service) => {
  const alias = root + '-alias'; await fs.symlink(root, alias);
  try {
    const file = path.join(alias, 'src', '文件 name.txt'); await fs.writeFile(file, 'alias change');
    assert.equal((await service.status(alias))?.states[path.join(alias, 'src')], 'modified');
    assert.match((await service.diff(alias, [file])).working, /alias change/);
    assert.ok(await service.prepare(alias, 'add', [file]));
  } finally { await fs.unlink(alias); }
}));
test('staging handles literal pathspec characters, newlines and option-like filenames', () => fixture(async (root, service) => {
  for (const name of ['-option.txt', '[a].txt', '中文\n name.txt']) {
    const file = path.join(root, name); await fs.writeFile(file, name);
    const plan = await service.prepare(root, 'add', [file]); await service.execute(plan.id, '');
  }
  assert.deepEqual((await service.prepare(root, 'commit', [root])).changes.map(c => c.path).sort(), ['-option.txt', '[a].txt', '中文\n name.txt'].sort());
}));
test('commit includes all reviewed staged files, leaving unstaged contents intact', () => fixture(async (root, service) => {
  const file = path.join(root, 'src', '文件 name.txt');
  await fs.writeFile(file, 'staged\n'); await git(root, 'add', '--', file); await fs.writeFile(file, 'unstaged\n');
  const diff = await service.diff(root, [file]); assert.match(diff.staged, /staged/); assert.match(diff.working, /unstaged/);
  const plan = await service.prepare(root, 'commit', [file]); assert.equal(plan.changes.length, 1);
  await service.execute(plan.id, 'commit staged only');
  assert.equal(await git(root, 'show', 'HEAD:src/文件 name.txt'), 'staged\n');
  assert.equal(await fs.readFile(file, 'utf8'), 'unstaged\n');
  await assert.rejects(service.execute(plan.id, 'again'), /失效/);
}));
test('changed staged contents invalidate a commit preview', () => fixture(async (root, service) => {
  const file = path.join(root, 'src', '文件 name.txt');
  await fs.writeFile(file, 'one'); await git(root, 'add', '--', file);
  const plan = await service.prepare(root, 'commit', [root]);
  await fs.writeFile(file, 'two'); await git(root, 'add', '--', file);
  await assert.rejects(service.execute(plan.id, 'must not commit'), /发生变化/);
  assert.equal(await git(root, 'show', 'HEAD:src/文件 name.txt'), 'original\n');
}));
test('discard backs up exact content and preserves staged and untracked files', () => fixture(async (root, service) => {
  const file = path.join(root, 'src', '文件 name.txt');
  await fs.writeFile(file, 'staged'); await git(root, 'add', '--', file); await fs.writeFile(file, 'precious unstaged');
  await fs.writeFile(path.join(root, 'new.txt'), 'keep me');
  const plan = await service.prepare(root, 'revert', [root]);
  assert.deepEqual(plan.changes.map(c => c.path), ['src/文件 name.txt']);
  const result = await service.execute(plan.id, ''); assert.ok(result.backup);
  assert.equal(await fs.readFile(file, 'utf8'), 'staged');
  assert.equal(await fs.readFile(path.join(result.backup, 'files', 'src', '文件 name.txt'), 'utf8'), 'precious unstaged');
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'keep me');
  assert.equal(await git(root, 'show', ':src/文件 name.txt'), 'staged');
}));
test('discard refuses changed content after the preview and does not follow symlinks', () => fixture(async (root, service) => {
  const file = path.join(root, 'src', '文件 name.txt'); await fs.writeFile(file, 'one');
  const plan = await service.prepare(root, 'revert', [file]); await fs.writeFile(file, 'two');
  await assert.rejects(service.execute(plan.id, ''), /发生变化/); assert.equal(await fs.readFile(file, 'utf8'), 'two');
  const link = path.join(root, 'link'); await fs.symlink('/etc', link);
  await assert.rejects(service.diff(root, [path.join(link, 'hosts')]), /同一仓库/);
  await assert.rejects(service.diff(root, [path.join(root, '.git', 'config')]), /同一仓库/);
  await assert.rejects(service.diff(root, ['/etc/hosts']), /同一仓库/);
}));
test('Git update fast-forwards a clean working tree and refuses divergent or dirty branches', () => fixture(async (root, service) => {
  const remote = root + '-remote'; const other = root + '-other';
  try {
    await git(root, 'clone', '--bare', root, remote); await git(root, 'remote', 'add', 'origin', remote); await git(root, 'fetch', 'origin'); await git(root, 'branch', '--set-upstream-to=origin/main');
    await git(root, 'clone', remote, other); await git(other, 'config', 'user.name', 'Fixture'); await git(other, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(other, 'remote.txt'), 'remote'); await git(other, 'add', '.'); await git(other, 'commit', '-m', 'remote'); await git(other, 'push');
    const plan = await service.prepare(root, 'update', [root]); await service.execute(plan.id, '');
    assert.equal(await fs.readFile(path.join(root, 'remote.txt'), 'utf8'), 'remote');
    await fs.writeFile(path.join(root, 'local.txt'), 'local');
    await assert.rejects(service.prepare(root, 'update', [root]), /本地更改/);
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'local');
    await fs.writeFile(path.join(other, 'other.txt'), 'other'); await git(other, 'add', '.'); await git(other, 'commit', '-m', 'other'); await git(other, 'push');
    const before = await git(root, 'rev-parse', 'HEAD'); const divergent = await service.prepare(root, 'update', [root]);
    await assert.rejects(service.execute(divergent.id, ''), /fast-forward|divergent/);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), before); assert.equal(await fs.readFile(path.join(root, 'local.txt'), 'utf8'), 'local');
  } finally { await fs.rm(remote, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); }
}));

const svnBinary = '/opt/homebrew/bin/svn';
const svnAvailable = existsSync(svnBinary);
async function svn(root: string, ...args: string[]) { return (await exec(svnBinary, ['--non-interactive', ...args], { cwd: root, encoding: 'utf8' })).stdout; }
async function svnFixture(run: (root: string, service: VersionControl, url: string) => Promise<void>) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-svn-')));
  const root = path.join(directory, 'wc');
  const service = new VersionControl(path.join(directory, 'backups'));
  try {
    const repository = path.join(directory, 'repository'); await exec('/opt/homebrew/bin/svnadmin', ['create', repository]);
    const url = pathToFileURL(repository).href;
    await svn(directory, 'checkout', url, root);
    await fs.writeFile(path.join(root, '中文 & name@.txt'), 'original\n');
    await svn(root, 'add', '--', '中文 & name@.txt@'); await svn(root, 'commit', '-m', 'fixture');
    await run(root, service, url);
  } finally { service.setEnabled(false); await fs.rm(directory, { recursive: true, force: true }); }
}
test('SVN real working copy detects clean, property-only modifications, ignored and unversioned files', { skip: !svnAvailable }, () => svnFixture(async (root, service) => {
  const file = path.join(root, '中文 & name@.txt');
  assert.equal((await service.status(root))?.states[file], 'clean');
  await svn(root, 'propset', 'custom:test', 'precious property', '--', '中文 & name@.txt@');
  await fs.writeFile(path.join(root, 'new.txt'), 'new');
  const status = await service.status(root, true);
  assert.ok(status && !status.error); assert.equal(status.states[file], 'modified'); assert.equal(status.states[path.join(root, 'new.txt')], 'untracked');
  assert.match((await service.diff(root, [file])).working, /precious property/);
}));
test('SVN add, commit and revert preserve content and property backups', { skip: !svnAvailable }, () => svnFixture(async (root, service) => {
  const added = path.join(root, '-new@.txt'); await fs.writeFile(added, 'added');
  const add = await service.prepare(root, 'add', [added]); await service.execute(add.id, '');
  const commit = await service.prepare(root, 'commit', [added]); await service.execute(commit.id, 'commit new file');
  assert.equal((await service.status(root, true))?.states[added], 'clean');
  await fs.writeFile(added, 'precious content'); await svn(root, 'propset', 'custom:test', 'precious property', '--', '-new@.txt@');
  const revert = await service.prepare(root, 'revert', [added]); const result = await service.execute(revert.id, '');
  assert.ok(result.backup); assert.equal(await fs.readFile(path.join(result.backup, 'files', '-new@.txt'), 'utf8'), 'precious content');
  assert.match(await fs.readFile(path.join(result.backup, 'properties.xml'), 'utf8'), /precious property/);
  assert.equal(await fs.readFile(added, 'utf8'), 'added');
}));
test('SVN update a clean working copy against a local repository', { skip: !svnAvailable }, () => svnFixture(async (root, service, url) => {
  const second = path.join(path.dirname(root), 'second'); await svn(root, 'checkout', url, second);
  await fs.writeFile(path.join(second, 'remote.txt'), 'remote'); await svn(second, 'add', 'remote.txt'); await svn(second, 'commit', '-m', 'remote');
  const plan = await service.prepare(root, 'update', [root]); await service.execute(plan.id, '');
  assert.equal(await fs.readFile(path.join(root, 'remote.txt'), 'utf8'), 'remote');
}));
test('SVN refuses adding nested version control directories', { skip: !svnAvailable }, () => svnFixture(async (root, service) => {
  const nested = path.join(root, 'new', 'nested'); await fs.mkdir(nested, { recursive: true }); await git(nested, 'init');
  await assert.rejects(service.prepare(root, 'add', [path.join(root, 'new')]), /子仓库/);
}));
test('SVN conflict discard backs up the local mine file before SVN removes it', { skip: !svnAvailable }, () => svnFixture(async (root, service, url) => {
  const file = path.join(root, '中文 & name@.txt');
  const second = path.join(path.dirname(root), 'second'); await svn(root, 'checkout', url, second);
  await fs.writeFile(path.join(second, '中文 & name@.txt'), 'remote\n'); await svn(second, 'commit', '-m', 'remote');
  await fs.writeFile(file, 'precious local\n'); await svn(root, 'update', '--accept', 'postpone');
  assert.equal((await service.status(root, true))?.states[file], 'conflict');
  const plan = await service.prepare(root, 'revert', [file]); const result = await service.execute(plan.id, '');
  assert.ok(result.backup); assert.equal(await fs.readFile(path.join(result.backup, 'files', '中文 & name@.txt.mine'), 'utf8'), 'precious local\n');
  assert.equal(await fs.readFile(file, 'utf8'), 'remote\n');
}));
test('SVN added directories commit their reviewed children and do not lose unversioned files on revert', { skip: !svnAvailable }, () => svnFixture(async (root, service) => {
  const directory = path.join(root, 'new folder'); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'a.txt'), 'new');
  const add = await service.prepare(root, 'add', [directory]); await service.execute(add.id, '');
  const commit = await service.prepare(root, 'commit', [directory]); assert.equal(commit.changes.length, 2); await service.execute(commit.id, 'directory');
  assert.equal((await service.status(root, true))?.states[directory], 'clean');
  await fs.writeFile(path.join(directory, 'a.txt'), 'keep in backup'); await fs.writeFile(path.join(directory, 'unversioned.txt'), 'preserve');
  const revert = await service.prepare(root, 'revert', [directory]); await service.execute(revert.id, '');
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'new'); assert.equal(await fs.readFile(path.join(directory, 'unversioned.txt'), 'utf8'), 'preserve');
}));
