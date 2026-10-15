import type { LanguageMode, LanguageState } from './i18n';
import type { OperationShortcuts } from './shortcuts';
import type { VcsAction, VcsDiff, VcsPlan, VcsResult, VcsStatus } from './vcs';
import type { FolderView, FolderViewChange, FolderViewOverride, LegacyFolderViews } from './folder-views';
export interface FileEntry {
  path: string; name: string; isDirectory: boolean; isSymlink: boolean;
  size: number; modified: number; created: number; extension: string; hidden: boolean;
}
export interface Place { path: string; name: string; icon: string }
export interface ShareService { title: string; icon: string }
export interface FileViewerSettings { enabled: boolean; canRestore: boolean; available: boolean; error: string }
export interface Volume extends Place { total: number; free: number; canEject: boolean; isNetwork: boolean }
export interface NetworkServer { name: string; address: string }
export type ThemeMode = 'light' | 'dark' | 'system';
export interface TabState { location: string; history: string[]; index: number }
export interface Bootstrap { initialTab?: TabState; language: LanguageState; theme: ThemeMode; home: string; places: Place[]; volumes: Volume[]; folderViews: { defaults: FolderView; overrides: Record<string, FolderViewOverride> }; initialPath?: string }
export interface Listing { path: string; entries: FileEntry[] }
export interface TrashListing { entries: FileEntry[]; roots: string[]; unavailable: string[] }
export interface SearchResult { entries: FileEntry[]; truncated: boolean; skipped: number }
export interface FileChange { from?: string; to: string }
export interface OperationResult { succeeded: string[]; errors: { path: string; message: string }[]; changes?: FileChange[] }
export type ClipboardInfo = { paths: string[]; cut: boolean };
export type Preview = { kind: 'image' | 'text' | 'none'; content: string; truncated?: boolean };
export type ExtractMode = 'choose' | 'here' | 'folder';
export interface AppSettings { wakeShortcut: string; wakeShortcutError: string; operationShortcuts: OperationShortcuts; versionControl: boolean; folderViewDefaults: FolderView }
export interface ArchivePreview { path: string; name: string; entries: { path: string; directory: boolean; size: number }[] }
export interface AboutInfo { version: string; author: string; license: string; platform: string }
export interface UpdateState {
  currentVersion: string; status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';
  latestVersion?: string; error?: string; downloaded: number; total: number; canInstall: boolean;
}
export interface ExplorerAPI {
  bootstrap(): Promise<Bootstrap>;
  detachTab(tab: TabState, point: { x: number; y: number }, single: boolean): Promise<void>;
  windowReady(): Promise<void>;
  setLanguage(mode: LanguageMode): Promise<LanguageState>;
  onLanguageChanged(callback: (state: LanguageState) => void): () => void;
  openPrivacySettings(): Promise<void>;
  volumes(): Promise<Volume[]>;
  ejectVolume(path: string): Promise<Volume[]>;
  discoverNetwork(): Promise<NetworkServer[]>;
  connectNetwork(address: string): Promise<string[] | null>;
  chooseAirDropFiles(): Promise<string[] | null>;
  listTrash(directory?: string): Promise<TrashListing>;
  restoreTrash(paths: string[], choose?: boolean): Promise<OperationResult | null>;
  emptyTrash(): Promise<OperationResult | null>;
  takeOpenPaths(): Promise<string[]>;
  onOpenPaths(callback: () => void): () => void;
  setTheme(mode: ThemeMode): Promise<ThemeMode>;
  about(): Promise<AboutInfo>;
  updateState(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  onUpdateChanged(callback: (state: UpdateState) => void): () => void;
  openProject(page: 'home' | 'issues' | 'license' | 'releases'): Promise<void>;
  settings(): Promise<AppSettings>;
  fileViewerSettings(): Promise<FileViewerSettings>;
  setFileViewer(enabled: boolean): Promise<FileViewerSettings>;
  setVersionControl(enabled: boolean): Promise<AppSettings>;
  vcsStatus(directory: string, force?: boolean): Promise<VcsStatus | null>;
  vcsDiff(directory: string, paths: string[]): Promise<VcsDiff>;
  vcsPrepare(directory: string, action: VcsAction, paths: string[]): Promise<VcsPlan>;
  vcsExecute(id: string, message: string): Promise<VcsResult>;
  captureShortcut(active: boolean): Promise<void>;
  setWakeShortcut(value: string): Promise<AppSettings>;
  setOperationShortcuts(value: OperationShortcuts): Promise<AppSettings>;
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
  setFolderView(location: string, override: FolderViewOverride): Promise<FolderViewOverride | null>;
  touchFolderView(location: string): Promise<void>;
  importLegacyFolderViews(legacy: LegacyFolderViews): Promise<void>;
  setFolderViewDefaults(defaults: FolderView): Promise<AppSettings>;
  resetFolderViews(defaults?: FolderView): Promise<AppSettings>;
  onFolderViewsChanged(callback: (change: FolderViewChange) => void): () => void;
  list(path: string, refreshIcons?: boolean): Promise<Listing>;
  search(path: string, query: string, hidden: boolean): Promise<SearchResult>;
  cancelSearch(): Promise<void>;
  open(path: string): Promise<ArchivePreview | null>;
  compressArchive(paths: string[]): Promise<string>;
  openArchiveFile(path: string, member: string): Promise<void>;
  extractArchive(path: string, selected: string[] | null, mode: ExtractMode): Promise<OperationResult | null>;
  openWith(paths: string[], editor?: 'textedit'): Promise<boolean>;
  quickLook(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  openTerminal(path: string): Promise<void>;
  shareServices(paths: string[]): Promise<ShareService[]>;
  share(paths: string[], service: string): Promise<void>;
  airDrop(paths: string[]): Promise<void>;
  info(path: string): Promise<FileEntry>;
  preview(path: string): Promise<Preview>;
  icon(path: string, pixels?: number): Promise<string>;
  create(parent: string, name: string, directory: boolean): Promise<string>;
  rename(path: string, name: string): Promise<string>;
  trash(paths: string[]): Promise<OperationResult>;
  clipboardSet(paths: string[], cut: boolean): Promise<ClipboardInfo>;
  clipboardGet(): Promise<ClipboardInfo>;
  paste(parent: string, move?: boolean): Promise<OperationResult>;
  closeWindow(): Promise<void>;
  moveTo(paths: string[], parent: string): Promise<OperationResult>;
  copyTo(paths: string[], parent: string): Promise<OperationResult>;
  history(): Promise<string | null>;
  undo(): Promise<OperationResult>;
  copyText(text: string): Promise<void>;
  chooseFolder(): Promise<string | null>;
  filePath(file: File): string;
  startFileDrag(paths: string[]): Promise<void>;
  watch(path: string | null): Promise<void>;
  onDirectoryChange(callback: () => void): () => void;
  onAction(callback: (action: string) => void): () => void;
  onScrollGestureStart(callback: (timestamp: number) => void): () => void;
}
