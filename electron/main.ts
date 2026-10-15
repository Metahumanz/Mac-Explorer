import { AppUpdates } from './updates';
import { networkAddress } from './network';
import packageInfo from '../package.json';
import { bindingsFor, migrateOperationShortcuts, normalizeShortcut, validWakeShortcut, validateWakeBinding, validateOperationShortcuts, type OperationShortcuts } from '../shared/shortcuts';
import { languageState, loadLanguage, saveLanguage } from './language';
import { fileViewerSettings } from './file-viewer';
import { t as tr } from '../shared/i18n';
import { app, BrowserWindow, globalShortcut, ipcMain, shell, clipboard, ClipboardItem, dialog, Menu, nativeTheme, screen, type Rectangle } from 'electron';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { watch, mkdirSync, writeFileSync, renameSync, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { absolute, createEntry, entryFor, listDirectory, readableError, renameEntry, searchDirectory, transferEntries, moveNoReplace } from './files';
import { compressArchive, extractArchive, prepareArchiveFile, previewArchive } from './archives';
import { isArchive } from '../shared/archives';
import { FileHistory } from './history';
import { FileIcons } from './icons';
import { VersionControl } from './vcs';
import { FolderViews } from './folder-views';
import { validFolderView, validLayout, validOverride, validSort, type FolderViewChange, type LegacyFolderViews } from '../shared/folder-views';
import type { VcsAction } from '../shared/vcs';
import { listTrash, TrashOrigins, snapshotTrash, emptyTrash } from './trash';
import type { AppSettings, TabState, Bootstrap, ClipboardInfo, OperationResult, Place, Preview, ShareService, ThemeMode, Volume, NetworkServer } from '../shared/types';

let currentLanguage = 'zh-CN';
// Preserve the requesting window across awaits, even when focus changes.
const requestWindow = new AsyncLocalStorage<BrowserWindow>();
const windows = new Map<BrowserWindow, { initialTab?: TabState; watcher?: FSWatcher; watchTimer?: NodeJS.Timeout; searchController?: AbortController; ready?: () => void; rendererReady?: boolean; pendingSettings?: boolean; pendingTabs?: number }>();
let lastActiveWindow: BrowserWindow | undefined;
const currentWindow = () => requestWindow.getStore() || BrowserWindow.getFocusedWindow() || lastActiveWindow || windows.keys().next().value;
const fileIcons = new FileIcons(path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/file-icon'));
const history = new FileHistory();
const isDev = process.env.EXPLORER_DEV === '1';
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
let savedWindowBounds: Rectangle | undefined;
let rememberTimer: NodeJS.Timeout | undefined;
const testRoot = process.env.EXPLORER_TEST_ROOT;
if (testRoot) app.setPath('userData', path.join(testRoot, '.app-data'));
app.setName('Mac Explorer');
let activeRequests = 0;
let installingUpdate = false;
const updates = new AppUpdates(app.getVersion(), path.join(app.getPath('userData'), 'updates'),
  app.isPackaged && !testRoot && process.platform === 'darwin' && process.arch === 'arm64' ? path.dirname(path.dirname(path.dirname(process.execPath))) : undefined,
  path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/update-install.sh'),
  state => { for (const owner of windows.keys()) owner.webContents.send('update-changed', state); });
const openPaths: string[] = [];
let readyForOpen = false;
// LaunchServices can deliver documents before app.whenReady or the renderer exists.
app.on('open-file', (event, input) => {
  event.preventDefault();
  try { openPaths.push(absolute(input)); } catch { return; }
  if (!readyForOpen) return;
  const window = currentWindow() || createWindow();
  if (window?.isMinimized()) window.restore();
  window?.show(); window?.focus();
  window?.webContents.send('open-paths');
});

function protect(input: string) {
  const value = absolute(input);
  if (['/', '/System', '/Library', '/Applications', '/Users', os.homedir()].includes(value)) throw new Error(tr('不能修改这个系统位置。'));
  return value;
}
function pathsArg(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(tr('无效的文件选择。'));
  return value.map(absolute);
}
function ipc(name: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(name, async (event, ...args) => {
    const url = event.senderFrame?.url;
    const trusted = isDev ? url?.startsWith('http://127.0.0.1:5173/') : url === pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner) || !trusted) throw new Error(tr('不受信任的请求。'));
    if (installingUpdate && !['update-state', 'about'].includes(name)) throw new Error(tr('正在准备重启，请稍候。'));
    activeRequests++;
    try { return await requestWindow.run(owner, () => handler(...args)); }
    catch (error) { throw new Error(readableError(error)); }
    finally { activeRequests--; }
  });
}
const FILE_URL_TYPE = 'electron application/osclipboard;format="public.file-url"';
const FILES_TYPE = 'electron application/osclipboard;format="local.macexplorer.files"';
async function clipboardText(item: Electron.ClipboardItem, mime: string) {
  const payload = await item.getType(mime);
  return 'text' in payload ? payload.text() : '';
}
async function getClipboard(): Promise<ClipboardInfo> {
  const items = await clipboard.read();
  const paths: string[] = [];
  for (const item of items) {
    if (item.types.includes(FILES_TYPE)) {
      try { const data = JSON.parse(await clipboardText(item, FILES_TYPE)); return { paths: pathsArg(data.paths), cut: data.cut === true }; }
      catch { /* Read native file URLs when custom data is unavailable. */ }
    }
    if (item.types.includes(FILE_URL_TYPE)) {
      try { paths.push(fileURLToPath((await clipboardText(item, FILE_URL_TYPE)).replace(/\0/g, ''))); } catch { /* Not a valid file URL. */ }
    }
  }
  if (!paths.length) for (const line of (await clipboard.readText()).split(/\r?\n/)) {
    if (line.startsWith('file://')) { try { paths.push(fileURLToPath(line)); } catch { /* Invalid URL. */ } }
  }
  return { paths, cut: false };
}
async function setClipboard(paths: string[], cut: boolean): Promise<ClipboardInfo> {
  if (!paths.length) { clipboard.clear(); return { paths, cut }; }
  await clipboard.write(paths.map((p, index) => new ClipboardItem({
    [FILE_URL_TYPE]: pathToFileURL(p).href,
    ...(index === 0 ? { 'text/plain': paths.map(p => pathToFileURL(p).href).join('\n'), [FILES_TYPE]: JSON.stringify({ paths, cut }) } : {}),
  })));
  return { paths, cut };
}
async function readVolumes(input?: string): Promise<Volume[]> {
  const helper = path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/volumes');
  try {
    const { stdout } = await promisify(execFile)(helper, input ? ['eject', input] : ['list']);
    return JSON.parse(stdout);
  } catch (error) {
    const message = tr((error as { stderr?: string }).stderr?.trim() || '');
    throw new Error(input ? tr('无法推出磁盘：{0}。请关闭正在使用它的文件或应用后重试。', message || readableError(error)) : message || readableError(error));
  }
}
ipc('volumes', () => readVolumes());
const networkHelper = path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/network');
let networkDiscovery: Promise<NetworkServer[]> | undefined;
let connectingNetwork = false;
ipc('network-discover', () => {
  if (!networkDiscovery) networkDiscovery = promisify(execFile)(networkHelper, ['discover'], { timeout: 10000 }).then(({ stdout }) => JSON.parse(stdout) as NetworkServer[]).catch(error => {
    throw new Error(tr('无法发现网络设备：{0}。请检查本地网络权限或手动输入服务器地址。', error.stderr?.trim() || readableError(error)));
  }).finally(() => { networkDiscovery = undefined; });
  return networkDiscovery;
});
ipc('network-connect', async (input: unknown) => {
  const address = networkAddress(input);
  if (connectingNetwork) throw new Error(tr('正在连接服务器，请先完成或取消系统登录窗口。'));
  connectingNetwork = true;
  try {
    const { stdout } = await promisify(execFile)(networkHelper, ['connect', address], { timeout: 120000 });
    const mounts: string[] | null = JSON.parse(stdout);
    if (mounts === null) return null;
    if (!Array.isArray(mounts) || !mounts.length) throw new Error(tr('服务器未返回可用的共享文件夹。'));
    for (const mount of mounts) if (!(await fs.stat(absolute(mount))).isDirectory()) throw new Error(tr('服务器未返回可用的共享文件夹。'));
    return mounts;
  } catch (error) {
    throw new Error(tr('无法连接服务器：{0}。', (error as { stderr?: string }).stderr?.trim() || readableError(error)));
  } finally { connectingNetwork = false; }
});
ipc('choose-airdrop-files', async () => {
  const result = await dialog.showOpenDialog(currentWindow()!, { title: tr('选择要隔空投送的文件'), properties: ['openFile', 'openDirectory', 'multiSelections'] });
  return result.canceled ? null : result.filePaths;
});
ipc('eject-volume', async (input: unknown) => {
  const requested = absolute(input);
  if (testRoot && requested !== process.env.EXPLORER_TEST_EJECT_VOLUME) throw new Error(tr('测试实例只能推出指定的临时磁盘。'));
  return readVolumes(requested);
});
async function bootstrap(): Promise<Bootstrap> {
  const home = testRoot || os.homedir();
  const candidates: Place[] = [
    { name: tr('应用程序'), path: testRoot ? path.join(home, 'Applications') : '/Applications', icon: 'applications' },
    { name: tr('桌面'), path: path.join(home, 'Desktop'), icon: 'desktop' },
    { name: tr('下载'), path: path.join(home, 'Downloads'), icon: 'download' },
    { name: tr('文档'), path: path.join(home, 'Documents'), icon: 'document' },
    { name: tr('图片'), path: path.join(home, 'Pictures'), icon: 'image' },
    { name: tr('音乐'), path: path.join(home, 'Music'), icon: 'music' },
    { name: tr('视频'), path: path.join(home, 'Movies'), icon: 'video' },
  ];
  const places = (await Promise.all(candidates.map(async place => (await fs.stat(place.path).catch(() => null))?.isDirectory() ? place : null))).filter((p): p is Place => p !== null);
  const volumes = await readVolumes();
  return { initialTab: windows.get(currentWindow()!)?.initialTab, language: languageState(), theme: nativeTheme.themeSource, home, places, volumes, folderViews: { defaults: folderViews.defaults, overrides: folderViews.overrides() }, initialPath: testRoot ? path.join(testRoot, 'Documents') : process.env.EXPLORER_START_PATH };
}
ipc('bootstrap', bootstrap);
ipc('set-language', async (mode: unknown) => {
  const state = await saveLanguage(mode);
  currentLanguage = state.locale;
  buildMenu();
  for (const window of windows.keys()) { window.setTitle(tr('文件资源管理器')); window.webContents.send('language-changed', state); }
  return state;
});
// Fixed destination only: renderer cannot supply arbitrary external URLs.
ipc('open-privacy-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'));
const trashOrigins = new TrashOrigins(path.join(app.getPath('userData'), 'trash-origins'));
async function trashRoots() {
  const home = testRoot || os.homedir();
  const volumes = testRoot ? path.join(testRoot, 'Volumes') : '/Volumes';
  const mounted = await fs.readdir(volumes).catch(() => [] as string[]);
  const roots = [path.join(home, '.Trash'), ...mounted.map(name => path.join(volumes, name, '.Trashes', String(process.getuid!())))];
  return roots;
}
ipc('list-trash', async (directory?: string) => listTrash(await trashRoots(), directory));
ipc('restore-trash', async (inputs: unknown, choose: unknown = false) => {
  const paths = pathsArg(inputs);
  let destination: string | undefined;
  const origins = await Promise.all(paths.map(input => trashOrigins.original(input)));
  const missing = (await Promise.all(origins.map(async origin => !origin || !(await fs.stat(path.dirname(origin)).catch(() => null))?.isDirectory()))).some(Boolean);
  if (choose === true || missing) {
    const picked = await dialog.showOpenDialog(currentWindow()!, { title: missing ? tr('无法确定原位置，请选择还原文件夹') : tr('还原到…'), buttonLabel: tr('还原到此处'), properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    destination = picked.filePaths[0];
  }
  const result = await trashOrigins.restore(await trashRoots(), paths, destination);
  if (result.succeeded.length) history.clear();
  return result;
});
let emptyingTrash = false;
ipc('empty-trash', async () => {
  if (emptyingTrash) throw new Error(tr('回收站正在处理中。'));
  emptyingTrash = true;
  try {
    const roots = await trashRoots();
    const snapshot = await snapshotTrash(roots);
    if (!snapshot.length) return { succeeded: [], errors: [] };
    const answer = await dialog.showMessageBox(currentWindow()!, { type: 'warning', title: tr('清空回收站'), message: tr('永久删除回收站中的 {0} 个项目？', snapshot.length), detail: tr('包含本机及已连接磁盘的回收站。此操作无法撤销。确认后新加入的顶层项目将保留。'), buttons: [tr('取消'), tr('永久删除')], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return null;
    const result = await emptyTrash(roots, snapshot);
    if (result.succeeded.length) history.clear();
    return result;
  } finally { emptyingTrash = false; }
});
async function moveToSystemTrash(input: string) {
  const source = protect(input);
  let trashed: string;
  if (testRoot) {
    // Isolated test instances must never write to the user's actual Trash.
    const root = path.join(testRoot, '.Trash');
    await fs.mkdir(root, { recursive: true });
    trashed = path.join(root, path.basename(source));
    await moveNoReplace(source, trashed);
  } else {
    const helper = path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/trash-item');
    const { stdout } = await promisify(execFile)(helper, [source]);
    trashed = absolute(JSON.parse(stdout).path);
  }
  try { await trashOrigins.remember(trashed, source); }
  catch { throw new Error(tr('文件已移入回收站，但无法保存原位置。请在回收站使用“还原到…”恢复。')); }
}
ipc('take-open-paths', () => openPaths.splice(0));
let nativeSharing: { airDrop(paths: string[]): void; shareServices(paths: string[]): ShareService[]; share(paths: string[], service: string): void } | undefined;
let wakeShortcut = '';
let operationShortcuts: OperationShortcuts = {};
let wakeShortcutError = '';
let savingShortcut = false;
let versionControlEnabled = true;
const versionControl = new VersionControl(path.join(app.getPath('userData'), 'vcs-backups'));
const folderViews = new FolderViews(path.join(app.getPath('userData'), 'folder-views.json'));
const versionControlFile = () => path.join(app.getPath('userData'), 'version-control.json');
const shortcutFile = () => path.join(app.getPath('userData'), 'shortcuts.json');
function appSettings(): AppSettings {
  return { wakeShortcut, wakeShortcutError, operationShortcuts, versionControl: versionControlEnabled, folderViewDefaults: folderViews.defaults };
}
async function writeShortcutSettings(nextWake: string, nextOperations: OperationShortcuts) {
  const file = shortcutFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify({ operationShortcutsVersion: 2, wakeShortcut: nextWake, operationShortcuts: nextOperations }), 'utf8');
  await fs.rename(file + '.tmp', file);
}
function notifySettings() {
  buildMenu();
  for (const owner of windows.keys()) owner.webContents.send('settings-changed', appSettings());
}
ipc('about', () => ({ version: app.getVersion(), author: packageInfo.author, license: packageInfo.license, platform: `macOS · ${process.arch === 'arm64' ? 'Apple Silicon' : process.arch}` }));
ipc('update-state', () => updates.restore());
ipc('check-update', () => updates.check());
ipc('download-update', () => updates.download());
ipc('install-update', async () => {
  if (activeRequests > 1 || extracting) throw new Error(tr('正在处理文件，请等待完成后再安装更新。'));
  installingUpdate = true;
  try { const state = await updates.install(process.pid); setImmediate(() => app.quit()); return state; }
  catch (error) { installingUpdate = false; throw error; }
});
ipc('open-project', (page: unknown) => {
  const destinations = { home: '', issues: '/issues', license: '/blob/main/LICENSE', releases: '/releases' };
  if (typeof page !== 'string' || !Object.hasOwn(destinations, page)) throw new Error(tr('无效的项目链接。'));
  return shell.openExternal(`https://github.com/qixiaoyu27/Mac-Explorer${destinations[page as keyof typeof destinations]}`);
});
ipc('settings', appSettings);
ipc('file-viewer-settings', () => fileViewerSettings());
ipc('set-file-viewer', async (enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error(tr('无效的文件查看器设置。'));
  const state = await fileViewerSettings(enabled);
  notifySettings();
  return state;
});
ipc('set-version-control', async (enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error(tr('无效的版本控制设置。'));
  if (savingShortcut) throw new Error(tr('设置正在保存，请稍后重试。'));
  savingShortcut = true;
  try {
    const file = versionControlFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify({ enabled }), 'utf8');
    await fs.rename(file + '.tmp', file);
    versionControlEnabled = enabled; versionControl.setEnabled(enabled);
    notifySettings();
    return appSettings();
  } finally { savingShortcut = false; }
});
function folderViewLocation(input: unknown) {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) throw new Error(tr('无效的视图设置。'));
  return input;
}
function folderViewDefaults(input: unknown) {
  if (!validFolderView(input)) throw new Error(tr('无效的视图设置。'));
  return input;
}
function notifyFolderViews(change: FolderViewChange) {
  for (const owner of windows.keys()) owner.webContents.send('folder-views-changed', change);
}
ipc('set-folder-view', async (location: unknown, override: unknown) => {
  const key = folderViewLocation(location);
  if (!validOverride(override)) throw new Error(tr('无效的视图设置。'));
  const { override: stored, removed } = await folderViews.set(key, override);
  for (const location of removed) notifyFolderViews({ location, override: null });
  notifyFolderViews({ location: key, override: stored });
  return stored;
});
ipc('touch-folder-view', async (location: unknown) => {
  const key = folderViewLocation(location);
  if (await folderViews.touch(key)) notifyFolderViews({ location: key, override: null });
});
ipc('import-legacy-folder-views', async (input: unknown) => {
  const legacy = input as LegacyFolderViews;
  if (!legacy || typeof legacy !== 'object' || !legacy.layouts || typeof legacy.layouts !== 'object' || Array.isArray(legacy.layouts) || Object.keys(legacy.layouts).length > 10_000) throw new Error(tr('无效的视图设置。'));
  const layouts = Object.fromEntries(Object.entries(legacy.layouts).filter(([location, layout]) => { try { folderViewLocation(location); return validLayout(layout); } catch { return false; } }));
  await folderViews.importLegacy({ layouts, sort: validSort(legacy.sort) ? legacy.sort : undefined });
  notifySettings();
});
ipc('set-folder-view-defaults', async (input: unknown) => {
  await folderViews.setDefaults(folderViewDefaults(input));
  notifySettings();
  return appSettings();
});
ipc('reset-folder-views', async (input: unknown) => {
  await folderViews.reset(input === undefined ? undefined : folderViewDefaults(input));
  // New defaults first, so no window briefly shows the old defaults.
  notifySettings();
  notifyFolderViews({ reset: true });
  return appSettings();
});
ipc('vcs-status', (directory: string, force: unknown = false) => versionControl.status(directory, force === true));
ipc('vcs-diff', (directory: string, paths: string[]) => versionControl.diff(directory, paths));
ipc('vcs-prepare', (directory: string, action: VcsAction, paths: string[]) => versionControl.prepare(directory, action, paths));
ipc('vcs-execute', (id: string, message: string) => versionControl.execute(id, message));
ipc('capture-shortcut', (active: unknown) => {
  if (typeof active !== 'boolean') throw new Error(tr('无效的快捷键设置。'));
  currentWindow()!.webContents.setIgnoreMenuShortcuts(active);
});
ipc('set-wake-shortcut', async (value: unknown) => {
  const next = validateWakeBinding(value, operationShortcuts);
  if (savingShortcut) throw new Error(tr('设置正在保存，请稍后重试。'));
  savingShortcut = true;
  const alreadyRegistered = !!next && globalShortcut.isRegistered(next) && next === wakeShortcut;
  let registered = false;
  try {
    if (next && !alreadyRegistered) {
      registered = globalShortcut.register(next, summon);
      if (!registered) throw new Error(tr('快捷键已被占用，请使用其他组合。'));
    }
    await writeShortcutSettings(next, operationShortcuts);
    if (wakeShortcut && wakeShortcut !== next) globalShortcut.unregister(wakeShortcut);
    wakeShortcut = next; wakeShortcutError = '';
    notifySettings();
    return appSettings();
  } catch (error) {
    if (registered) globalShortcut.unregister(next);
    throw error;
  } finally { savingShortcut = false; }
});
ipc('set-operation-shortcuts', async (value: unknown) => {
  const next = validateOperationShortcuts(value, wakeShortcut);
  if (savingShortcut) throw new Error(tr('设置正在保存，请稍后重试。'));
  savingShortcut = true;
  try {
    await writeShortcutSettings(wakeShortcut, next);
    operationShortcuts = next;
    notifySettings();
    return appSettings();
  } finally { savingShortcut = false; }
});
function isThemeMode(value: unknown): value is ThemeMode { return value === 'light' || value === 'dark' || value === 'system'; }
ipc('set-theme', async (mode: unknown) => {
  if (!isThemeMode(mode)) throw new Error(tr('无效的外观设置。'));
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(path.join(app.getPath('userData'), 'appearance.json'), JSON.stringify({ theme: mode }), 'utf8');
  nativeTheme.themeSource = mode;
  for (const window of windows.keys()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff');
  return mode;
});
ipc('list', (input: string, refreshIcons: unknown = false) => {
  const directory = absolute(input);
  if (refreshIcons === true) fileIcons.clearCache();
  return listDirectory(directory);
});
ipc('search', async (input: string, query: string, hidden: boolean) => {
  const state = windows.get(currentWindow()!)!;
  state.searchController?.abort();
  state.searchController = new AbortController();
  return searchDirectory(absolute(input), String(query), !!hidden, state.searchController.signal);
});
ipc('cancel-search', () => windows.get(currentWindow()!)?.searchController?.abort());
ipc('info', (input: string) => entryFor(absolute(input)));
ipc('open', async (input: string) => {
  const filePath = absolute(input);
  await fs.access(filePath);
  if (isArchive(filePath) && (await fs.stat(filePath)).isFile()) return previewArchive(filePath);
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  return null;
});
// ponytail: one archive operation at a time; use per-destination locks if parallel jobs are needed.
let extracting = false;
app.on('before-quit', event => { if (extracting) event.preventDefault(); });
ipc('compress-archive', async (inputs: unknown) => {
  if (extracting) throw new Error(tr('正在处理压缩包，请等待完成。'));
  extracting = true;
  try { return await compressArchive(pathsArg(inputs)); }
  finally { extracting = false; }
});
ipc('open-archive-file', async (input: string, member: unknown) => {
  if (extracting) throw new Error(tr('正在处理压缩包，请等待完成。'));
  extracting = true;
  try {
    const temporary = await prepareArchiveFile(absolute(input), member);
    try {
      const error = await shell.openPath(temporary.filePath);
      if (error) throw new Error(error);
      // Keep the temporary copy after closing the preview so external editors can save it.
      // Changes are never written back into the archive.
    } catch (error) { await fs.rm(temporary.directory, { recursive: true, force: true }); throw error; }
  } finally { extracting = false; }
});
ipc('extract-archive', async (input: string, selected: unknown, mode: unknown) => {
  if (extracting) throw new Error(tr('正在解压，请等待完成。'));
  if (mode !== 'choose' && mode !== 'here' && mode !== 'folder') throw new Error(tr('无效的解压位置。'));
  const filePath = absolute(input);
  extracting = true;
  try {
    let destination = path.dirname(filePath);
    if (mode === 'choose') {
      const choice = await dialog.showOpenDialog(currentWindow()!, { title: tr('选择解压位置'), buttonLabel: tr('解压到此处'), defaultPath: destination, properties: ['openDirectory', 'createDirectory'] });
      if (choice.canceled || !choice.filePaths.length) return null;
      destination = choice.filePaths[0];
    }
    return await extractArchive(filePath, destination, selected, mode === 'folder');
  } finally { extracting = false; }
});
ipc('reveal', (input: string) => shell.showItemInFolder(absolute(input)));
ipc('open-with', async (inputs: unknown, editor?: unknown) => {
  if (editor !== undefined && editor !== 'textedit') throw new Error(tr('无效的文本编辑器。'));
  const paths = [...new Set(pathsArg(inputs))];
  if (!paths.length) throw new Error(tr('请先选择要打开的文件。'));
  for (const filePath of paths) {
    if (!(await fs.stat(filePath)).isFile()) throw new Error(tr('请选择文件，然后选择打开方式。'));
  }
  if (editor === 'textedit') {
    // A running TextEdit ignores launch arguments. Use a separate instance with
    // volatile overrides so HTML/RTF opens as source without changing user defaults.
    await promisify(execFile)('/usr/bin/open', ['-n', '-b', 'com.apple.TextEdit', ...paths, '--args', '-IgnoreHTML', 'YES', '-IgnoreRichText', 'YES']);
    return true;
  }
  const choice = await dialog.showOpenDialog(currentWindow()!, {
    title: tr('选择打开方式'),
    message: paths.length === 1 ? tr('选择用于打开“{0}”的应用', path.basename(paths[0])) : tr('选择用于打开这 {0} 个文件的应用', paths.length),
    buttonLabel: tr('用此应用打开'),
    defaultPath: '/Applications',
    filters: [{ name: tr('应用程序'), extensions: ['app'] }],
    properties: ['openFile'],
  });
  if (choice.canceled || !choice.filePaths.length) return false;
  const application = absolute(choice.filePaths[0]);
  if (path.extname(application).toLowerCase() !== '.app' || !(await fs.stat(application)).isDirectory()) throw new Error(tr('请选择有效的 Mac 应用程序（.app）。'));
  await fs.access(path.join(application, 'Contents/Info.plist'));
  // Launch Services receives arguments literally; this does not alter defaults
  // and never turns filenames into shell commands.
  await promisify(execFile)('/usr/bin/open', ['-a', application, ...paths]);
  return true;
});
ipc('open-terminal', async (input: string) => {
  const directory = absolute(input);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error(tr('请选择文件夹打开终端。'));
  // Pass the directory as a Launch Services document, never as shell code.
  // Terminal apps open a new session at this directory without Automation access.
  const helper = path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/default-terminal');
  let application: string;
  try { application = (await promisify(execFile)(helper)).stdout; }
  catch (error) { throw new Error(tr((error as { stderr?: string }).stderr?.trim() || '') || readableError(error)); }
  await promisify(execFile)('/usr/bin/open', ['-a', application, directory]);
});
async function sharePaths(inputs: unknown) {
  const paths = pathsArg(inputs);
  if (!paths.length) throw new Error(tr('请选择要共享的文件。'));
  for (const file of paths) await fs.access(file, 4);
  if (!nativeSharing) throw new Error(tr('当前没有可用的共享方式。'));
  return paths;
}
ipc('share-services', async (inputs: unknown) => {
  const paths = await sharePaths(inputs);
  return nativeSharing!.shareServices(paths);
});
ipc('share', async (inputs: unknown, service: unknown) => {
  if (typeof service !== 'string' || !service.trim() || service.includes('\0') || Buffer.byteLength(service) > 1024) throw new Error(tr('无效的共享方式。'));
  const paths = await sharePaths(inputs);
  const owner = currentWindow()!;
  if (owner.isMinimized()) owner.restore();
  owner.show(); owner.focus();
  nativeSharing!.share(paths, service);
});
ipc('airdrop', async (inputs: unknown) => {
  const paths = pathsArg(inputs);
  if (!paths.length) throw new Error(tr('请选择要隔空投送的文件。'));
  for (const file of paths) await fs.access(file, 4);
  if (!nativeSharing) throw new Error(tr('隔空投送服务不可用。'));
  const owner = currentWindow()!;
  if (owner.isMinimized()) owner.restore();
  owner.show(); owner.focus();
  try { nativeSharing.airDrop(paths); }
  catch (error) { throw new Error(tr((error as Error).message)); }
});
ipc('quick-look', (input: string) => {
  const filePath = absolute(input);
  if (process.platform === 'darwin') currentWindow()?.previewFile(filePath);
  else shell.openPath(filePath);
});
ipc('start-file-drag', async (inputs: unknown) => {
  const paths = [...new Set(pathsArg(inputs))];
  if (!paths.length) throw new Error(tr('无效的文件选择。'));
  const owner = currentWindow()!;
  for (const file of paths) await fs.access(file, 4);
  const icon = await app.getFileIcon(paths[0], { size: 'normal' });
  if (!owner.isDestroyed()) owner.webContents.startDrag({ file: paths[0], files: paths, icon });
});
ipc('icon', (input: string, pixels = 64) => fileIcons.get(absolute(input), typeof pixels === 'number' && Number.isFinite(pixels) ? Math.min(512, Math.max(32, pixels)) : 64));
ipc('preview', async (input: string): Promise<Preview> => {
  const filePath = absolute(input);
  const entry = await entryFor(filePath);
  if (entry.isDirectory) return { kind: 'none', content: '' };
  const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
  if (imageTypes[entry.extension] && entry.size < 12 * 1024 * 1024) {
    return { kind: 'image', content: `data:${imageTypes[entry.extension]};base64,${(await fs.readFile(filePath)).toString('base64')}` };
  }
  if (['txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'csv', 'log', 'swift', 'py', 'go', 'rs', 'sh', 'sql', 'gitignore', ''].includes(entry.extension)) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(16_384);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) return { kind: 'none', content: '' };
      return { kind: 'text', content: buffer.subarray(0, bytesRead).toString('utf8'), truncated: entry.size > bytesRead };
    } finally { await handle.close(); }
  }
  return { kind: 'none', content: '' };
});
ipc('create', async (parent: string, name: string, directory: boolean) => {
  const destination = await createEntry(absolute(parent), name, !!directory);
  await history.record('新建', [{ to: destination }]); return destination;
});
ipc('rename', async (input: string, name: string) => {
  const source = protect(input); const destination = await renameEntry(source, name);
  if (destination !== source) await history.record('重命名', [{ from: source, to: destination }]);
  return destination;
});
ipc('trash', async (inputs: unknown): Promise<OperationResult> => {
  const result: OperationResult = { succeeded: [], errors: [] };
  for (const input of pathsArg(inputs)) {
    try { await moveToSystemTrash(input); result.succeeded.push(input); }
    catch (error) { result.errors.push({ path: input, message: readableError(error) }); }
  }
  if (result.succeeded.length) history.clear();
  return result;
});
ipc('clipboard-set', (inputs: unknown, cut: boolean) => setClipboard(pathsArg(inputs), !!cut));
ipc('clipboard-get', getClipboard);
ipc('paste', async (parent: string, move: unknown = false) => {
  if (typeof move !== 'boolean') throw new Error(tr('无效的移动选项。'));
  const clip = await getClipboard();
  clip.cut ||= move;
  if (clip.cut) clip.paths.forEach(protect);
  const result = await transferEntries(clip.paths, absolute(parent), clip.cut);
  await history.record(clip.cut ? '移动' : '复制', result.changes || []);
  if (clip.cut) await setClipboard(clip.paths.filter(p => !result.succeeded.includes(p)), true);
  return result;
});
ipc('copy-to', async (inputs: unknown, parent: string) => {
  const result = await transferEntries(pathsArg(inputs), absolute(parent), false);
  await history.record('复制', result.changes || []); return result;
});
ipc('move-to', async (inputs: unknown, parent: string) => {
  const sources = pathsArg(inputs);
  sources.forEach(protect);
  const result = await transferEntries(sources, absolute(parent), true);
  await history.record('移动', result.changes || []); return result;
});
ipc('close-window', () => currentWindow()?.close());
ipc('history', () => history.label ? tr(history.label) : null);
ipc('undo', () => history.undo(moveNoReplace, input => moveToSystemTrash(input)));
ipc('copy-text', (value: string) => clipboard.writeText(String(value)));
ipc('choose-folder', async () => {
  const result = await dialog.showOpenDialog(currentWindow()!, { title: tr('选择要打开的文件夹'), properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipc('watch', (input: string | null) => {
  const owner = currentWindow()!;
  const state = windows.get(owner)!;
  state.watcher?.close(); state.watcher = undefined;
  clearTimeout(state.watchTimer);
  if (!input) return;
  try {
    state.watcher = watch(absolute(input), () => {
      clearTimeout(state.watchTimer);
      state.watchTimer = setTimeout(() => { if (!owner.isDestroyed()) owner.webContents.send('directory-changed'); }, 220);
    });
    state.watcher.on('error', () => { state.watcher?.close(); state.watcher = undefined; });
  } catch { /* Explicit refresh remains available for restricted volumes. */ }
});
ipc('window-ready', () => {
  const owner = currentWindow()!;
  const state = windows.get(owner)!;
  state.rendererReady = true;
  for (let remaining = state.pendingTabs || 0; remaining > 0; remaining--) owner.webContents.send('action', 'new-tab');
  state.pendingTabs = 0;
  if (state.pendingSettings) { state.pendingSettings = false; owner.webContents.send('action', 'settings'); }
  state.ready?.();
});
ipc('detach-tab', async (input: TabState, point: { x: number; y: number }, single: boolean) => {
  const validLocation = (value: unknown) => typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && (['computer', 'airdrop', 'network', 'trash'].includes(value) || value.startsWith('/') || value.startsWith('trash:/'));
  if (!input || !Array.isArray(input.history) || !input.history.length || input.history.length > 10000 || !input.history.every(validLocation) || !Number.isInteger(input.index) || input.index < 0 || input.index >= input.history.length || input.location !== input.history[input.index] || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || typeof single !== 'boolean') throw new Error(tr('无效的标签页。'));
  const owner = currentWindow()!;
  const area = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea;
  const x = Math.round(Math.max(area.x, Math.min(point.x - 160, area.x + area.width - 800)));
  const y = Math.round(Math.max(area.y, Math.min(point.y - 24, area.y + area.height - 100)));
  if (single) { owner.setPosition(x, y); return; }
  const target = createWindow({ location: input.location, history: [...input.history], index: input.index }, { x, y });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { if (!target.isDestroyed()) target.destroy(); reject(new Error(tr('无法打开新窗口，原标签页已保留。'))); }, 15000);
    windows.get(target)!.ready = () => { clearTimeout(timer); resolve(); };
    target.once('closed', () => { clearTimeout(timer); reject(new Error(tr('新窗口已关闭，原标签页已保留。'))); });
  });
});

// Windows remember their geometry in userData the same way the appearance and language
// preferences do, so a new window opens where the last one was left.
function visibleEnough(area: Rectangle, bounds: Rectangle) {
  const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return width >= 120 && height >= 80;
}
function usableBounds(saved: Record<string, unknown>): Rectangle | undefined {
  const values = [saved.x, saved.y, saved.width, saved.height];
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return undefined;
  const [x, y, width, height] = values as number[];
  const bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  if (bounds.width < 800 || bounds.height < 530) return undefined;
  // Discard geometry that no longer touches a display: an unplugged monitor would otherwise
  // reopen every window off screen, with no visible way back.
  return screen.getAllDisplays().some(display => visibleEnough(display.workArea, bounds)) ? bounds : undefined;
}
async function loadWindowBounds() {
  try {
    const saved = JSON.parse(await fs.readFile(windowStateFile(), 'utf8')) as Record<string, unknown>;
    return usableBounds(saved || {});
  } catch { /* Open at the default size until a window records its geometry. */ }
}
function saveWindowBounds(window: BrowserWindow) {
  // Minimized and full screen windows report geometry that must not become the next default.
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  savedWindowBounds = bounds;
  try {
    const file = windowStateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(bounds), 'utf8');
    renameSync(file + '.tmp', file);
  } catch { /* Keep the last written geometry when the preference cannot be saved. */ }
}
function rememberBounds(window: BrowserWindow) {
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => { void saveWindowBounds(window); }, 400);
}

function createWindow(initialTab?: TabState, position?: { x: number; y: number }) {
  // A dragged tab states where it lands, so saved geometry applies only to ordinary new windows.
  const restore = position ? undefined : savedWindowBounds;
  const window = new BrowserWindow({
    ...position,
    ...restore,
    width: restore?.width ?? 1260, height: restore?.height ?? 820, minWidth: 800, minHeight: 530, title: tr('文件资源管理器'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  windows.set(window, { initialTab });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || !window) return;
    Menu.buildFromTemplate([
      { role: 'undo', label: tr('撤销'), enabled: params.editFlags.canUndo },
      { type: 'separator' },
      { role: 'cut', label: tr('剪切'), enabled: params.editFlags.canCut },
      { role: 'copy', label: tr('复制'), enabled: params.editFlags.canCopy },
      { role: 'paste', label: tr('粘贴'), enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: tr('全选') },
    ]).popup({ window });
  });
  window.once('ready-to-show', () => { if (!(testRoot && process.env.EXPLORER_TEST_HIDDEN === '1')) window?.show(); });
  if (isDev) window.loadURL('http://127.0.0.1:5173/');
  else window.loadFile(path.join(__dirname, '../dist/index.html'));
  window.on('close', event => { if (extracting) event.preventDefault(); });
  // Flush on close so quitting right after a drag still keeps the final geometry.
  window.on('close', () => { clearTimeout(rememberTimer); saveWindowBounds(window); });
  // Resizing and dragging both report live and settled events; programmatic moves can omit the
  // settled ones, so listen to every variant and let the throttle collapse the duplicates.
  window.on('resize', () => rememberBounds(window));
  window.on('resized', () => rememberBounds(window));
  window.on('move', () => rememberBounds(window));
  window.on('moved', () => rememberBounds(window));
  window.on('focus', () => { lastActiveWindow = window; const before = currentLanguage; const next = languageState(); if (next.locale !== before) { currentLanguage = next.locale; buildMenu(); for (const target of windows.keys()) target.webContents.send('language-changed', next); } });
  window.on('closed', () => { const state = windows.get(window); state?.watcher?.close(); state?.searchController?.abort(); clearTimeout(state?.watchTimer); windows.delete(window); if (lastActiveWindow === window) lastActiveWindow = undefined; });
  return window;
}
function summon() {
  const window = currentWindow();
  if (!window || window.isDestroyed()) createWindow();
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
}

const action = (name: string) => async () => {
  const contents = currentWindow()?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const edits = { copy: () => contents.copy(), cut: () => contents.cut(), paste: () => contents.paste(), 'select-all': () => contents.selectAll(), undo: () => contents.undo() };
  if (name in edits) {
    const editable = await contents.executeJavaScript('document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement || document.activeElement?.isContentEditable === true');
    if (contents.isDestroyed()) return;
    if (editable) { edits[name as keyof typeof edits](); return; }
  }
  contents.send('action', name);
};
function buildMenu() {
  if (process.platform === 'darwin') app.dock?.setMenu(Menu.buildFromTemplate([
    { label: tr('新建窗口'), click: () => { const home = testRoot || os.homedir(); createWindow({ location: home, history: [home], index: 0 }); } },
    { label: tr('新建标签页'), click: () => {
      const owner = currentWindow();
      if (!owner) { const home = testRoot || os.homedir(); createWindow({ location: home, history: [home], index: 0 }); return; }
      if (owner.isMinimized()) owner.restore();
      owner.show(); owner.focus();
      const state = windows.get(owner)!;
      if (state.rendererReady) owner.webContents.send('action', 'new-tab');
      else state.pendingTabs = (state.pendingTabs || 0) + 1;
    } },
  ]));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Mac Explorer', submenu: [{ role: 'about', label: tr('关于 Mac Explorer') }, { label: tr('设置…'), accelerator: 'Command+,', click: () => {
      const owner = currentWindow() || createWindow();
      if (owner.isMinimized()) owner.restore();
      owner.show(); owner.focus();
      const state = windows.get(owner)!;
      if (state.rendererReady) owner.webContents.send('action', 'settings');
      else state.pendingSettings = true;
    } }, { type: 'separator' }, { role: 'hide', label: tr('隐藏') }, { role: 'quit', label: tr('退出') }] },
    { label: tr('文件'), submenu: [{ label: tr('新建标签页'), accelerator: bindingsFor('new-tab', operationShortcuts)[0], click: action('new-tab') }, { label: tr('打开文件夹…'), click: action('choose-folder') }, { label: tr('新建文件夹'), accelerator: bindingsFor('new-folder', operationShortcuts)[0], click: action('new-folder') }, { type: 'separator' }, { label: tr('关闭标签页'), accelerator: bindingsFor('close-tab', operationShortcuts)[0], click: action('close-tab') }, { role: 'close', label: tr('关闭窗口'), accelerator: 'Command+Shift+W' }] },
    { label: tr('编辑'), submenu: [{ label: tr('撤销'), accelerator: bindingsFor('undo', operationShortcuts)[0], click: action('undo') }, { type: 'separator' }, { label: tr('剪切'), accelerator: bindingsFor('cut', operationShortcuts)[0], click: action('cut') }, { label: tr('复制'), accelerator: bindingsFor('copy', operationShortcuts)[0], click: action('copy') }, { label: tr('粘贴'), accelerator: bindingsFor('paste', operationShortcuts)[0], click: action('paste') }, { label: tr('将项目移到这里'), accelerator: bindingsFor('move-here', operationShortcuts)[0], click: action('move-here') }, { label: tr('全选'), accelerator: bindingsFor('select-all', operationShortcuts)[0], click: action('select-all') }] },
    { label: tr('显示'), submenu: [{ label: tr('刷新'), accelerator: bindingsFor('refresh', operationShortcuts)[0], click: action('refresh') }, { label: tr('显示隐藏的项目'), accelerator: bindingsFor('hidden', operationShortcuts)[0], click: action('hidden') }, { role: 'togglefullscreen', label: tr('进入全屏') }] },
    { label: tr('窗口'), submenu: [{ role: 'minimize', label: tr('最小化') }, { role: 'zoom', label: tr('缩放') }, { role: 'front', label: tr('前置全部窗口') }] },
  ]));
}
app.whenReady().then(async () => {
  // Set native and renderer appearance before the first window is created.
  nativeTheme.themeSource = 'light';
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'appearance.json'), 'utf8'));
    if (isThemeMode(saved.theme)) nativeTheme.themeSource = saved.theme;
  } catch { /* Keep the existing light appearance when no valid preference exists. */ }
  savedWindowBounds = await loadWindowBounds();
  try {
    const saved = JSON.parse(await fs.readFile(versionControlFile(), 'utf8'));
    versionControlEnabled = saved.enabled !== false;
  } catch { /* Version control is enabled by default, including existing installs. */ }
  versionControl.setEnabled(versionControlEnabled);
  await folderViews.load();
  nativeTheme.on('updated', () => { for (const window of windows.keys()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff'); });
  try {
    const saved = JSON.parse(await fs.readFile(shortcutFile(), 'utf8'));
    try {
      operationShortcuts = saved.operationShortcutsVersion === 2 ? validateOperationShortcuts(saved.operationShortcuts ?? {}) :
        migrateOperationShortcuts(saved.operationShortcuts ?? {}, validWakeShortcut(saved.wakeShortcut) ? saved.wakeShortcut : '');
    } catch { /* Invalid mappings fall back to defaults. */ }
    if (validWakeShortcut(saved.wakeShortcut) && saved.wakeShortcut) {
      wakeShortcut = normalizeShortcut(saved.wakeShortcut)!;
      try {
        validateWakeBinding(wakeShortcut, operationShortcuts);
        if (!globalShortcut.register(wakeShortcut, summon)) wakeShortcutError = tr('快捷键已被占用，请使用其他组合。');
      } catch (error) { wakeShortcutError = readableError(error); }
    }
  } catch { /* Use default operation shortcuts and leave global wake disabled. */ }
  currentLanguage = (await loadLanguage()).locale;
  buildMenu();
  readyForOpen = true;
  createWindow();
  if (process.platform === 'darwin') {
    const gesturePath = path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/scroll-gesture.node');
    const gestures = require(gesturePath) as { start(callback: (timestamp: number) => void): void };
    gestures.start(timestamp => {
      const window = BrowserWindow.getFocusedWindow();
      if (window && !window.isDestroyed()) window.webContents.send('scroll-gesture-start', timestamp);
    });
    try {
      nativeSharing = require(path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/defaults.node')) as typeof nativeSharing;
    } catch { /* Sharing stays unavailable when the native addon cannot be loaded. */ }
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || testRoot) app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); fileIcons.close(); versionControl.setEnabled(false); });
