import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-installer-test-'));
const installDir = path.join(root, 'Applications');
const bin = path.join(root, 'bin');
const fixture = process.env.EXPLORER_INSTALLER_FIXTURES;
if (!fixture) throw new Error('Set EXPLORER_INSTALLER_FIXTURES to a release directory containing ZIP and SHA256SUMS.txt.');
try {
  await fs.mkdir(bin);
  const stub = async (name, source) => fs.writeFile(path.join(bin, name), `#!/bin/bash\nset -eu\n${source}\n`, { mode: 0o755 });
  await stub('pgrep', '[[ "${TEST_RUNNING:-0}" == 1 ]]');
  await stub('curl', `headers=''; output=''; url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump-header) headers="$2"; shift 2;;
    -o) output="$2"; shift 2;;
    https://*) url="$1"; shift;;
    *) shift;;
  esac
done
if [[ "\${TEST_NETWORK_FAILURE:-0}" == 1 ]]; then exit 22; fi
if [[ "$url" == *.zip ]]; then
  printf 'zip\\n' >> "$TEST_DOWNLOAD_LOG"
  if [[ "\${TEST_ZIP_FAILURE:-0}" == 1 ]]; then exit 22; fi
  if [[ "\${TEST_UNKNOWN_SIZE:-0}" == 1 ]]; then printf 'HTTP/2 200\\r\\n\\r\\n' > "$headers"
  else printf 'HTTP/2 302\\r\\nContent-Length: 10\\r\\n\\r\\nHTTP/2 200\\r\\nContent-Length: %s\\r\\n\\r\\n' "$(stat -f%z "$TEST_FIXTURES/\${url##*/}")" > "$headers"; fi
  sleep 1
fi
cp "$TEST_FIXTURES/\${url##*/}" "$output"
if [[ "\${TEST_CORRUPT:-0}" == 1 && "$url" == *.zip ]]; then printf damaged >> "$output"; fi`);
  await stub('mv', `if [[ "\${TEST_MOVE_FAILURE:-0}" == 1 && "$1" == */.mac-explorer-install.*/"Mac Explorer.app" ]]; then exit 1; fi
exec /bin/mv "$@"`);
  await stub('ditto', `/usr/bin/ditto "$@"
target="\${@: -1}"
if [[ "$target" == *.app ]]; then
  /usr/bin/xattr -w com.apple.quarantine '0081;00000000;InstallerTest;' "$target"
  /usr/bin/xattr -w com.macexplorer.installer-test preserved "$target"
fi`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAC_EXPLORER_INSTALL_DIR: installDir, MAC_EXPLORER_NO_OPEN: '1', MAC_EXPLORER_ALLOW_UNNOTARIZED: '0', TEST_DOWNLOAD_LOG: path.join(root, 'downloads'), TEST_FIXTURES: path.resolve(fixture) };
  const run = extra => exec('/bin/bash', ['scripts/install.sh'], { env: { ...env, ...extra }, maxBuffer: 1024 * 1024 });
  const app = path.join(installDir, 'Mac Explorer.app');
  const firstInstall = await run();
  assert.equal((firstInstall.stdout.match(/⭐ Star/g) || []).length, 1);
  assert.match(firstInstall.stdout, /✓ 安装完成/);
  assert.match(firstInstall.stdout, /╭─ MAC EXPLORER/);
  assert.match(firstInstall.stdout, /https:\/\/github.com\/qixiaoyu27\/Mac-Explorer/);
  assert.equal(firstInstall.stdout.includes('\x1b['), false); // Redirected output has no ANSI codes.
  await exec('codesign', ['--verify', '--deep', '--strict', app]);
  assert.match((await exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app])).stdout, /InstallerTest/);
  assert.match(firstInstall.stdout, /【[\d.]+ MiB】\/【[\d.]+ MiB】   【100%】/);
  const original = await fs.readFile(path.join(app, 'Contents/Info.plist'));
  const setVersion = async version => {
    await exec('/usr/libexec/PlistBuddy', ['-c', `Set CFBundleShortVersionString ${version}`, path.join(app, 'Contents/Info.plist')]);
    await exec('codesign', ['--force', '--deep', '--sign', '-', app]);
    return fs.readFile(path.join(app, 'Contents/Info.plist'));
  };
  const downloads = await fs.readFile(env.TEST_DOWNLOAD_LOG, 'utf8');
  assert.match((await run({ TEST_RUNNING: '1' })).stdout, /已是最新版/);
  await setVersion('99.0.0');
  assert.match((await run()).stdout, /不降级/);
  assert.equal(await fs.readFile(env.TEST_DOWNLOAD_LOG, 'utf8'), downloads);
  await setVersion('0.1.9'); // Numeric, not lexicographic comparison.
  assert.match((await run()).stdout, /发现新版本/);
  await assert.rejects(fs.access(path.join(installDir, '.Mac Explorer Backups')));
  assert.deepEqual((await fs.readdir(installDir)).filter(name => name.startsWith('.mac-explorer-install.')), []);
  for (const extra of [{ TEST_CORRUPT: '1' }, { TEST_NETWORK_FAILURE: '1' }, { TEST_RUNNING: '1' }, { TEST_MOVE_FAILURE: '1' }, { TEST_ZIP_FAILURE: '1' }]) {
    const older = await setVersion('0.1.9');
    await assert.rejects(run(extra), error => {
      if (extra.TEST_ZIP_FAILURE) assert.doesNotMatch(error.stdout, /【100%】/);
      return true;
    });
    assert.deepEqual(await fs.readFile(path.join(app, 'Contents/Info.plist')), older);
    await exec('codesign', ['--verify', '--deep', '--strict', app]);
  }
  assert.deepEqual((await fs.readdir(installDir)).filter(name => name.startsWith('.mac-explorer-install.')), []);
  const unrelated = path.join(root, 'unrelated'); await fs.writeFile(unrelated, 'preserved');
  await exec('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Unrelated;', unrelated]);
  const optInInstall = await run({ MAC_EXPLORER_ALLOW_UNNOTARIZED: '1', TEST_UNKNOWN_SIZE: '1' });
  assert.match(optInInstall.stdout, /【100%】/);
  assert.equal((optInInstall.stdout.match(/⭐ Star/g) || []).length, 1);
  await assert.rejects(exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app]));
  assert.equal((await exec('/usr/bin/xattr', ['-p', 'com.macexplorer.installer-test', app])).stdout.trim(), 'preserved');
  assert.match((await exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', unrelated])).stdout, /Unrelated/);
  await exec('codesign', ['--verify', '--deep', '--strict', app]);
  assert.deepEqual(await fs.readFile(path.join(app, 'Contents/Info.plist')), original);
  const older = await setVersion('0.1.9');
  await assert.rejects(run({ MAC_EXPLORER_ALLOW_UNNOTARIZED: '1', TEST_CORRUPT: '1' }));
  assert.deepEqual(await fs.readFile(path.join(app, 'Contents/Info.plist')), older);
  // Rewrite only real installation locations so default routing is tested in isolation.
  const installer = await fs.readFile('scripts/install.sh', 'utf8');
  assert.ok(installer.includes('install_dir="${MAC_EXPLORER_INSTALL_DIR:-/Applications}"'));
  const systemDir = path.join(root, 'System Applications');
  const legacyDir = path.join(root, 'Personal Applications'); await fs.mkdir(legacyDir);
  const systemApp = path.join(systemDir, 'Mac Explorer.app');
  const legacyApp = path.join(legacyDir, 'Mac Explorer.app');
  const isolated = path.join(root, 'install-isolated.sh');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(isolated, installer.replace(':-/Applications}', `:-${systemDir}}`).replace('legacy_app="$HOME/Applications/Mac Explorer.app"', `legacy_app=${quote(legacyApp)}`).replace('"$install_dir" == /Applications', `"$install_dir" == ${quote(systemDir)}`));
  await exec('/bin/bash', ['-n', isolated]);
  const defaultRun = extra => exec('/bin/bash', [isolated], { env: { ...env, MAC_EXPLORER_INSTALL_DIR: '', ...extra }, maxBuffer: 1024 * 1024 });
  await defaultRun();
  await fs.access(path.join(systemApp, 'Contents/Info.plist'));
  await assert.rejects(fs.access(legacyApp));
  await fs.rename(systemApp, legacyApp);
  for (const extra of [{ TEST_RUNNING: '1' }, { TEST_NETWORK_FAILURE: '1' }]) {
    await assert.rejects(defaultRun(extra)); await fs.access(legacyApp); await assert.rejects(fs.access(systemApp));
  }
  const beforeMigration = await fs.readFile(path.join(legacyApp, 'Contents/Info.plist'));
  assert.match((await defaultRun()).stdout, /已移至应用程序/);
  assert.deepEqual(await fs.readFile(path.join(systemApp, 'Contents/Info.plist')), beforeMigration);
  await assert.rejects(fs.access(legacyApp));
  await fs.rename(systemApp, legacyApp);
  await exec('/usr/libexec/PlistBuddy', ['-c', 'Set CFBundleShortVersionString 99.0.0', path.join(legacyApp, 'Contents/Info.plist')]);
  await exec('codesign', ['--force', '--deep', '--sign', '-', legacyApp]);
  assert.match((await defaultRun()).stdout, /不降级/);
  assert.match(await fs.readFile(path.join(systemApp, 'Contents/Info.plist'), 'utf8'), /99.0.0/);
  await fs.rename(systemApp, legacyApp);
  await exec('/usr/libexec/PlistBuddy', ['-c', 'Set CFBundleShortVersionString 0.1.9', path.join(legacyApp, 'Contents/Info.plist')]);
  await exec('codesign', ['--force', '--deep', '--sign', '-', legacyApp]);
  const legacyBeforeUpdate = await fs.readFile(path.join(legacyApp, 'Contents/Info.plist'));
  await assert.rejects(defaultRun({ TEST_MOVE_FAILURE: '1' }));
  assert.deepEqual(await fs.readFile(path.join(legacyApp, 'Contents/Info.plist')), legacyBeforeUpdate);
  await assert.rejects(fs.access(systemApp));
  assert.deepEqual((await fs.readdir(systemDir)).filter(name => name.startsWith('.mac-explorer-install.')), []);
  assert.match((await defaultRun()).stdout, /安装完成/);
  await assert.rejects(fs.access(legacyApp));
  await exec('codesign', ['--verify', '--deep', '--strict', systemApp]);
  await fs.rename(systemApp, legacyApp);
  const linkTarget = path.join(root, 'unrelated.app'); await fs.mkdir(linkTarget); await fs.writeFile(path.join(linkTarget, 'keep.txt'), 'keep');
  await fs.symlink(linkTarget, systemApp);
  await assert.rejects(defaultRun(), /符号链接/);
  assert.equal(await fs.readFile(path.join(linkTarget, 'keep.txt'), 'utf8'), 'keep');
  await fs.unlink(systemApp);
  await fs.mkdir(systemApp); await fs.writeFile(path.join(systemApp, 'keep.txt'), 'keep');
  await assert.rejects(defaultRun(), /其他应用/);
  assert.equal(await fs.readFile(path.join(systemApp, 'keep.txt'), 'utf8'), 'keep');
  await fs.rm(systemApp, { recursive: true });
  await fs.rename(legacyApp, linkTarget + '.saved'); await fs.symlink(linkTarget, legacyApp);
  await assert.rejects(defaultRun(), /符号链接/);
  assert.equal(await fs.readFile(path.join(linkTarget, 'keep.txt'), 'utf8'), 'keep');
  console.log('PASS: system Applications default, personal-app migration at same/newer/older versions, migration rollback and collision/symlink protection, custom install/update/rollback, quarantine preservation and opt-in; temporary fixtures only, no app launched.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
