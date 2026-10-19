import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import nodeAPIHeaders from 'node-api-headers';

fs.mkdirSync('dist-electron/native', { recursive: true });
fs.copyFileSync('scripts/install.sh', 'dist-electron/native/install.sh');
fs.copyFileSync('scripts/update-install.sh', 'dist-electron/native/update-install.sh');
fs.cpSync('electron/templates', 'dist-electron/templates', { recursive: true });
const gestureSource = 'electron/native/ScrollGesture.mm';
const gestureBinary = 'dist-electron/native/scroll-gesture.node';
if (!fs.existsSync(gestureBinary) || Math.max(fs.statSync(gestureSource).mtimeMs, fs.statSync('scripts/build-electron.mjs').mtimeMs) > fs.statSync(gestureBinary).mtimeMs) {
  execFileSync('xcrun', ['clang++', '-target', 'arm64-apple-macos13.0', '-std=c++17', '-fobjc-arc', '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-DNAPI_VERSION=8', '-I', nodeAPIHeaders.include_dir, gestureSource, '-o', gestureBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', gestureBinary], { stdio: 'inherit' });
}
const defaultsSource = 'electron/native/Defaults.mm';
const defaultsBinary = 'dist-electron/native/defaults.node';
if (!fs.existsSync(defaultsBinary) || Math.max(fs.statSync(defaultsSource).mtimeMs, fs.statSync('scripts/build-electron.mjs').mtimeMs) > fs.statSync(defaultsBinary).mtimeMs) {
  execFileSync('xcrun', ['clang++', '-target', 'arm64-apple-macos13.0', '-std=c++17', '-fobjc-arc', '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-DNAPI_VERSION=8', '-I', nodeAPIHeaders.include_dir, defaultsSource, '-o', defaultsBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', defaultsBinary], { stdio: 'inherit' });
}
const source = 'electron/native/FileIcon.swift';
const binary = 'dist-electron/native/file-icon';
if (!fs.existsSync(binary) || Math.max(fs.statSync(source).mtimeMs, fs.statSync('scripts/build-electron.mjs').mtimeMs) > fs.statSync(binary).mtimeMs) {
  execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos13.0', '-O', source, '-o', binary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
}
fs.rmSync('dist-electron/native/trash-item', { force: true });
const volumesSource = 'electron/native/Volumes.swift';
const volumesBinary = 'dist-electron/native/volumes';
if (!fs.existsSync(volumesBinary) || fs.statSync(volumesSource).mtimeMs > fs.statSync(volumesBinary).mtimeMs) {
  execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos13.0', '-O', volumesSource, '-o', volumesBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', volumesBinary], { stdio: 'inherit' });
}
const terminalSource = 'electron/native/DefaultTerminal.swift';
const networkSource = 'electron/native/Network.swift';
const networkBinary = 'dist-electron/native/network';
if (!fs.existsSync(networkBinary) || fs.statSync(networkSource).mtimeMs > fs.statSync(networkBinary).mtimeMs) {
  execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos13.0', '-O', networkSource, '-o', networkBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', networkBinary], { stdio: 'inherit' });
}
const viewerSource = 'electron/native/FileViewer.swift';
const viewerBinary = 'dist-electron/native/file-viewer';
if (!fs.existsSync(viewerBinary) || Math.max(fs.statSync(viewerSource).mtimeMs, fs.statSync('scripts/build-electron.mjs').mtimeMs) > fs.statSync(viewerBinary).mtimeMs) {
  execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos13.0', '-O', viewerSource, '-o', viewerBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', viewerBinary], { stdio: 'inherit' });
}
const terminalBinary = 'dist-electron/native/default-terminal';
if (!fs.existsSync(terminalBinary) || fs.statSync(terminalSource).mtimeMs > fs.statSync(terminalBinary).mtimeMs) {
  execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos13.0', '-O', terminalSource, '-o', terminalBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', terminalBinary], { stdio: 'inherit' });
}
const favoritesSource = 'electron/native/FinderFavorites.swift';
const favoritesBinary = 'dist-electron/native/finder-favorites';
if (!fs.existsSync(favoritesBinary) || Math.max(fs.statSync(favoritesSource).mtimeMs, fs.statSync('scripts/build-electron.mjs').mtimeMs) > fs.statSync(favoritesBinary).mtimeMs) {
  execFileSync('xcrun', ['swiftc', '-suppress-warnings', '-target', 'arm64-apple-macos13.0', '-O', favoritesSource, '-o', favoritesBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', favoritesBinary], { stdio: 'inherit' });
}
const archiveSource ='electron/native/ArchiveReader.c';
const archiveBinary = 'dist-electron/native/archive-reader';
if (!fs.existsSync(archiveBinary) || Math.max(fs.statSync(archiveSource).mtimeMs, fs.statSync('scripts/build-electron.mjs').mtimeMs) > fs.statSync(archiveBinary).mtimeMs) {
  execFileSync('xcrun', ['clang', '-target', 'arm64-apple-macos13.0', '-O2', '-Wall', '-Wextra', archiveSource, '-larchive.2', '-o', archiveBinary], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', archiveBinary], { stdio: 'inherit' });
}
await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
