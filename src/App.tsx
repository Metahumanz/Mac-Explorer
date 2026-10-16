import { AboutPanel } from './AboutPanel';
import { AirDropPage, NetworkPage } from './ConnectionPages';
import { bindingsFor, formatShortcut, shortcutActions, shortcutActionIDs, shortcutFromEvent, validateOperationShortcuts, validateWakeBinding, type OperationShortcuts, type ShortcutAction } from '../shared/shortcuts';
import { t as tr, getLocale, setLocale, type LanguageState, type LanguageMode } from '../shared/i18n';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  Archive, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, ArrowDownWideNarrow, Radar, Check, ChevronDown, ChevronRight,
  ClipboardPaste, Copy, Download, ExternalLink, FilePlus2, FileText, Film, FolderOpen,
  FolderPlus, HardDrive, Image, Info, CircleHelp, LayoutGrid, List, Loader2, Sheet, Presentation,
  PanelLeft, Eye, FileType, SquareCheck, ChevronsDownUp,
  Monitor, MoreHorizontal, Music2, PanelRight, Pin, Plus, RotateCw, Scissors, AppWindow, Globe,
  Search, Share2, Star, Sun, Moon, Terminal, TextCursorInput, Trash2, Undo2, X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { archiveFolderName, isArchive } from '../shared/archives';
import { toolbarActions, defaultToolbar, normalizeToolbar, type ToolbarAction } from '../shared/toolbar';
import { defaultFolderView, normalizeOverride, resolveFolderView, type FolderLayout, type FolderSort, type FolderView, type FolderViewOverride, type SortKey, type ViewMode } from '../shared/folder-views';
import type { AppSettings, FileViewerSettings, ExtractMode, ArchivePreview, Bootstrap, ClipboardInfo, FileEntry, OperationResult, Place, Preview, ThemeMode, Volume } from '../shared/types';
import { vcsMarks, type VcsAction, type VcsState, type VcsStatus } from '../shared/vcs';
import { VcsDialog, vcsStateLabel } from './VcsDialog';

const api = window.explorer;
const iniIcon = new URL('./assets/ini.png', import.meta.url).href;
const PC = 'computer';
const TRASH = 'trash';
const AIRDROP = 'airdrop';
const NETWORK = 'network';
// Internal drag types: a Quick Access item being reordered, and a file-list drag
// made only of folders (drag data is unreadable until drop).
const PLACE_TYPE = 'application/x-explorer-place';
const FOLDERS_TYPE = 'application/x-explorer-folders';
function isEditing(element: EventTarget | null) {
  return element instanceof Element && !!element.closest('input, textarea, select, [contenteditable="true"]');
}
function isTrashLocation(value: string) { return value === TRASH || value.startsWith('trash:'); }
type Tab = { id: string; location: string; history: string[]; index: number };
type View = ViewMode;
function withFolderView(views: Record<string, FolderViewOverride>, location: string, override: FolderViewOverride | null) {
  const next = { ...views }; delete next[location];
  if (override) next[location] = override;
  return next;
}
// Earlier versions kept folder layouts and the global sort in localStorage.
// Import them before the first bootstrap so the first listing already uses them.
async function migrateFolderViews() {
  const layouts = stored<unknown>('directoryViews', null); const sort = stored<unknown>('sort', null); const ascending = stored<unknown>('ascending', null);
  if (layouts === null && sort === null && ascending === null) return;
  await api.importLegacyFolderViews({
    layouts: layouts && typeof layouts === 'object' && !Array.isArray(layouts) ? layouts as Record<string, FolderLayout> : {},
    sort: { sort: sort ?? defaultFolderView.sort, ascending: ascending ?? defaultFolderView.ascending } as FolderSort,
  });
  for (const key of ['directoryViews', 'sort', 'ascending']) localStorage.removeItem(key);
}
type ToolbarTool = { name: string; label: string; icon: ReactNode; disabled: boolean; action: (event: MouseEvent<HTMLButtonElement>) => void };
type MenuItem = { children?: MenuItem[]; radio?: boolean; label: string; icon?: ReactNode; action?: () => void; shortcut?: string; checked?: boolean; disabled?: boolean; danger?: boolean; divider?: boolean };
type Popup = { x: number; y: number; items: MenuItem[]; quickActions?: MenuItem[] };
type Modal = { kind: 'archive'; archive: ArchivePreview } | { kind: 'folder' | 'file' | 'rename'; path: string; name: string } | { kind: 'trash'; paths: string[] } | { kind: 'settings' } | { kind: 'vcs'; directory: string; paths: string[]; action: VcsAction | 'diff' };
const makeTab = (location = ''): Tab => ({ id: crypto.randomUUID(), location, history: [location], index: 0 });
const isPlaceDrag = (event: React.DragEvent) => event.dataTransfer.types.includes(PLACE_TYPE);
function stored<T,>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function base(path: string) { return path.split('/').filter(Boolean).at(-1) || 'Macintosh HD'; }
function parent(path: string) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function join(path: string, name: string) { return `${path === '/' ? '' : path}/${name}`; }
function isVirtual(location: string) { return !location || location === PC || location === AIRDROP || location === NETWORK || isTrashLocation(location); }
function size(bytes: number) { return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: bytes >= 1e9 ? 1 : 0 }).format(bytes / (bytes >= 1024 ** 3 ? 1024 ** 3 : bytes >= 1024 ** 2 ? 1024 ** 2 : bytes >= 1024 ? 1024 : 1)) + ' ' + (bytes >= 1024 ** 3 ? 'GB' : bytes >= 1024 ** 2 ? 'MB' : bytes >= 1024 ? 'KB' : tr('字节')); }
function date(value: number) { return new Date(value).toLocaleString(getLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function type(entry: FileEntry) {
  if (entry.isDirectory) return entry.name.endsWith('.app') ? tr('应用程序') : entry.isSymlink ? tr('文件夹链接') : tr('文件夹');
  const names: Record<string, string> = { pdf: tr('PDF 文档'), txt: tr('文本文档'), md: tr('Markdown 文档'), png: tr('PNG 图像'), jpg: tr('JPEG 图像'), jpeg: tr('JPEG 图像'), heic: tr('HEIC 图像'), zip: tr('ZIP 压缩文件'), dmg: tr('磁盘映像'), mp4: tr('MP4 视频'), mov: tr('QuickTime 视频'), mp3: tr('MP3 音频'), docx: tr('Word 文档'), xlsx: tr('Excel 工作簿'), pptx: tr('PowerPoint 演示文稿') };
  return names[entry.extension] || (entry.extension ? tr('{0} 文件', entry.extension.toUpperCase()) : tr('文件'));
}
function errorMessage(error: unknown) { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

function Eject({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2 1.5 10h13L8 2Z"/><rect x="2" y="12" width="12" height="2" rx="0.5"/></svg>;
}

function PlaceIcon({ icon, size: dimension = 18 }: { icon: string; size?: number }) {
  if (icon === 'applications') return <svg width={dimension} height={dimension} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="place-icon icon-applications" aria-hidden="true"><path d="m9 3 10 17M15 3 5 20M3 15h11m4 0h3"/></svg>;
  const Component = ({ trash: Trash2, star: Star, desktop: Monitor, download: Download, document: FileText, image: Image, music: Music2, video: Film, drive: HardDrive, folder: FolderOpen, computer: Monitor, airdrop: Radar, network: Globe } as Record<string, typeof FolderOpen>)[icon] || FolderOpen;
  return <Component size={dimension} strokeWidth={1.6} className={`place-icon icon-${icon}`} aria-hidden="true" />;
}
function ViewGlyph({ mode }: { mode: 'extra' | 'large' | 'medium' | 'small' | 'list' | 'details' | 'tiles' | 'content' }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    {mode === 'extra' ? <><rect x="2" y="2" width="15" height="13" rx="1.5"/><path d="M4 18h11"/></> : mode === 'large' ? <><rect x="4" y="3" width="12" height="11" rx="1.5"/><path d="M4 17h12"/></> : mode === 'medium' ? <><rect x="6" y="2" width="8" height="8" rx="1"/><path d="M5 13h10M6 16h8"/></> : mode === 'small' ? <>{[3, 11].flatMap(x => [3, 11].map(y => <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" rx="1"/>))}</> : mode === 'list' ? <path d="M2 4h6m4 0h6M2 8h6m4 0h6M2 12h6m4 0h6M2 16h6m4 0h6"/> : mode === 'details' ? <path d="M2 4h16M2 8h16M2 12h16M2 16h16"/> : <>{(mode === 'tiles' ? [3, 12] : [2, 8, 14]).map(y => <g key={y}><rect x="2" y={y} width="4" height="4" rx="1"/><path d={`M10 ${y + 1}h8M10 ${y + 4}h5`}/></g>)}</>}
  </svg>;
}
function FolderGlyph({ dimension = 38, badge }: { dimension?: number; badge?: string }) {
  const id = useId();
  return <span className="folder-glyph" style={{ width: dimension, height: dimension }} aria-hidden="true">
    <svg viewBox="0 0 48 44" fill="none">
      <defs>
        <linearGradient id={`${id}-back`} x1="12" y1="5" x2="12" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffc928"/><stop offset="1" stopColor="#efa914"/>
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="6" y1="12" x2="40" y2="39" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffe79f"/><stop offset="0.5" stopColor="#ffdf75"/><stop offset="1" stopColor="#ffd039"/>
        </linearGradient>
      </defs>
      <path d="M3 8a3 3 0 0 1 3-3h9.3c2.1 0 3.4.6 4.8 2.1L23 10h19.5a2.5 2.5 0 0 1 2.5 2.5V35H3V8Z" fill={`url(#${id}-back)`}/>
      <path d="M6 10.4h17v5H3.7v-2.3A2.7 2.7 0 0 1 6 10.4Z" fill="#fff8df"/>
      <path d="M5.4 12.7h10.3c2.9 0 4.1-2.7 7-2.7h19.9a2.4 2.4 0 0 1 2.4 2.4v23.2a2.4 2.4 0 0 1-2.4 2.4H5.4A2.4 2.4 0 0 1 3 35.6V15.1a2.4 2.4 0 0 1 2.4-2.4Z" fill={`url(#${id}-front)`} stroke="#d7a92c" strokeOpacity=".65" strokeWidth=".45"/>
      <path d="M5.6 13.15h10.1c2.9 0 4.2-2.7 7-2.7h19.7" stroke="#fff3c3" strokeOpacity=".8" strokeWidth=".4" strokeLinecap="round"/>
    </svg>
    {badge && <span className={`folder-badge badge-${badge}`}><PlaceIcon icon={badge} size={Math.max(7, Math.round(dimension * 0.21))}/></span>}
  </span>;
}
function FileGlyph({ entry, dimension = 22, state, badge }: { entry: FileEntry; dimension?: number; state?: VcsState; badge?: string }) {
  const glyph = <FileGlyphBase entry={entry} dimension={dimension} badge={badge}/>;
  return state ? <span className="vcs-glyph" style={{ width: dimension, height: dimension }} title={vcsStateLabel(state)}><span className="vcs-base-icon">{glyph}</span><span className={`vcs-badge vcs-${state}`} data-vcs-state={state} role="img" aria-label={vcsStateLabel(state)} title={vcsStateLabel(state)}>{vcsMarks[state]}</span></span> : glyph;
}
function FileGlyphBase({ entry, dimension = 22, badge }: { entry: FileEntry; dimension?: number; badge?: string }) {
  const [icon, setIcon] = useState('');
  const isINI = !entry.isDirectory && entry.extension === 'ini';
  const pixels = Math.min(512, Math.max(64, 2 ** Math.ceil(Math.log2(dimension * window.devicePixelRatio))));
  useEffect(() => {
    let live = true;
    if (!isINI && (!entry.isDirectory || entry.name.endsWith('.app'))) api.icon(entry.path, pixels).then(value => { if (live) setIcon(value); }).catch(() => { if (live) setIcon(''); });
    return () => { live = false; };
  }, [entry, pixels, isINI]);
  if (entry.isDirectory && !entry.name.endsWith('.app')) return <FolderGlyph dimension={dimension} badge={badge}/>;
  const style = { width: dimension, height: dimension };
  if (isINI) return <img className="file-glyph" style={style} src={iniIcon} alt="" draggable={false}/>;
  return icon ? <img className="file-glyph" style={style} src={icon} alt="" draggable={false}/> : <FileText className="file-glyph" style={style} strokeWidth={1.2}/>;
}
function ToolButton({ label, children, onClick, disabled = false, active = false, className = '' }: { label: string; children: ReactNode; onClick: (event: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; active?: boolean; className?: string }) {
  return <button className={`tool-button ${active ? 'active' : ''} ${className}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function DriveGlyph({ path }: { path: string }) {
  const [icon, setIcon] = useState('');
  const pixels = Math.min(512, Math.max(64, 64 * window.devicePixelRatio));
  useEffect(() => {
    let live = true;
    setIcon('');
    api.icon(path, pixels).then(value => { if (live) setIcon(value); }).catch(() => {});
    return () => { live = false; };
  }, [path, pixels]);
  return icon ? <img className="drive-icon" src={icon} alt="" draggable={false}/> : <HardDrive className="drive-icon" strokeWidth={1.2} aria-hidden="true"/>;
}

export default function App() {
  const [toolbar, setToolbar] = useState(() => normalizeToolbar(stored('toolbar', null)));
  useEffect(() => { localStorage.setItem('toolbar', JSON.stringify(toolbar)); }, [toolbar]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === 'toolbar' || event.key === null) setToolbar(normalizeToolbar(stored('toolbar', null))); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const [operationShortcuts, setOperationShortcuts] = useState<OperationShortcuts>({});
  const [vcsEnabled, setVcsEnabled] = useState<boolean | null>(null);
  const [vcs, setVcs] = useState<{ directory: string; status: VcsStatus } | null>(null);
  useEffect(() => {
    let live = true;
    const receive = (value: AppSettings) => { if (live) { setOperationShortcuts(value.operationShortcuts); setVcsEnabled(value.versionControl); setFolderViewDefaults(value.folderViewDefaults); } };
    void api.settings().then(receive).catch(e => setError(errorMessage(e)));
    const stop = api.onSettingsChanged(receive);
    return () => { live = false; stop(); };
  }, []);
  function shortcutHint(action: ShortcutAction) { return formatShortcut(bindingsFor(action, operationShortcuts)[0] || ''); }
  function shortcutLabel(label: string, action: ShortcutAction) { const hint = shortcutHint(action); return hint ? tr('{0} ({1})', tr(label), hint) : tr(label); }
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [language, setLanguage] = useState<LanguageState>({ mode: 'system', locale: 'zh-CN' });
  function applyLanguage(state: LanguageState) {
    setLocale(state.locale); setLanguage(state);
    document.documentElement.lang = state.locale; document.title = tr('文件资源管理器');
  }
  async function changeLanguage(mode: LanguageMode) {
    applyLanguage(await api.setLanguage(mode));
    setBoot(await api.bootstrap()); setToast(''); setError(''); setTrashOperationError('');
    setRefresh(value => value + 1);
  }
  useEffect(() => api.onLanguageChanged(state => {
    applyLanguage(state); setPopup(null); setToast(''); setTrashOperationError('');
    void api.bootstrap().then(setBoot).catch(e => setError(errorMessage(e)));
    void api.history().then(setUndoLabel).catch(() => {});
    setRefresh(value => value + 1);
  }), []);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([makeTab()]);
  const [activeID, setActiveID] = useState('');
  const tab = tabs.find(t => t.id === activeID) || tabs[0];
  const location = tab.location;
  const connectionPage = location === AIRDROP || location === NETWORK;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<CSSProperties | null>(null);
  const cancelMarquee = useRef<(() => void) | null>(null);
  const suppressMarqueeClick = useRef(false);
  const selectionAnchor = useRef<string | null>(null);
  // The main process owns the defaults and per-folder overrides; this window
  // mirrors them. Layout and sort override the defaults independently.
  const [folderViewDefaults, setFolderViewDefaults] = useState<FolderView>(defaultFolderView);
  const [folderViews, setFolderViews] = useState<Record<string, FolderViewOverride>>({});
  const { view, iconSize, sort, ascending } = resolveFolderView(folderViewDefaults, folderViews[location]);
  // Listeners registered once read the latest state here, and consecutive
  // changes before a render build on each other rather than on that render.
  const folderViewScope = useRef({ location, defaults: folderViewDefaults, folderViews });
  folderViewScope.current = { location, defaults: folderViewDefaults, folderViews };
  function changeFolderView(override: (effective: FolderView) => FolderViewOverride) {
    const scope = folderViewScope.current;
    if (!scope.location) return;
    const current = scope.folderViews[scope.location] ?? {};
    const next = override(resolveFolderView(scope.defaults, current));
    scope.folderViews = withFolderView(scope.folderViews, scope.location, normalizeOverride(next, scope.defaults, current));
    setFolderViews(scope.folderViews);
    api.setFolderView(scope.location, next).catch(error => setError(errorMessage(error)));
  }
  const changeView = (changes: Partial<FolderLayout>) => changeFolderView(effective => ({ layout: { view: effective.view, iconSize: effective.iconSize, ...changes } }));
  const changeSort = (changes: Partial<FolderSort>) => changeFolderView(effective => ({ sort: { sort: effective.sort, ascending: effective.ascending, ...changes } }));
  useEffect(() => api.onFolderViewsChanged(change => setFolderViews(previous => 'reset' in change ? {} : withFolderView(previous, change.location, change.override))), []);
  useEffect(() => { if (location) api.touchFolderView(location).catch(() => { /* Recency only. */ }); }, [location]);
  const [hidden, setHidden] = useState(() => stored('hidden', false));
  const [extensions, setExtensions] = useState(() => stored('extensions', true));
  const [details, setDetails] = useState(() => stored('details', false));
  const [previewPane, setPreviewPane] = useState(() => !stored('details', false) && stored('previewPane', false));
  const [navigationPane, setNavigationPane] = useState(() => stored('navigationPane', true));
  const [compact, setCompact] = useState(() => stored('compact', false));
  const [checkboxes, setCheckboxes] = useState(() => stored('checkboxes', false));
  const [pins, setPins] = useState<string[]>(() => stored('pins', []));
  const [unpinnedDefaults, setUnpinnedDefaults] = useState<string[]>(() => stored('unpinnedDefaults', []));
  const [placeOrder, setPlaceOrder] = useState<string[]>(() => stored('placeOrder', []));
  const [placeMarker, setPlaceMarker] = useState<{ index: number; top: number } | null>(null);
  const [recent, setRecent] = useState<string[]>(() => stored('recent', []));
  // Addresses submitted from the address bar, newest first, like Explorer's typed paths.
  const [typedPaths, setTypedPaths] = useState<string[]>(() => stored('typedPaths', []));
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [searchNote, setSearchNote] = useState('');
  const [trashRoots, setTrashRoots] = useState<string[]>([]);
  const [openingPrivacySettings, setOpeningPrivacySettings] = useState(false);
  async function openPrivacySettings() {
    if (openingPrivacySettings) return;
    setOpeningPrivacySettings(true);
    try { await api.openPrivacySettings(); }
    catch { setError(previous => previous + tr('\n无法打开系统设置，请手动前往“隐私与安全性 → 完全磁盘访问权限”。')); }
    finally { setOpeningPrivacySettings(false); }
  }
  const [trashOperationError, setTrashOperationError] = useState('');
  const viewingTrash = isTrashLocation(location);
  const [editingAddress, setEditingAddress] = useState(false);
  const [address, setAddress] = useState('');
  // Suggestions follow what the user typed; arrowing through them only changes
  // the input, so the list stays put. Until the first keystroke, show history.
  const [addressQuery, setAddressQuery] = useState<string | null>(null);
  const [addressActive, setAddressActive] = useState(-1);
  // Subfolders read during this edit, by directory; filtering by prefix happens in memory.
  const [addressFolders, setAddressFolders] = useState<Record<string, { name: string; hidden: boolean }[]>>({});
  const [refresh, setRefresh] = useState(0);
  const refreshIcons = useRef(false);
  function refreshDirectory() { refreshIcons.current = true; setRefresh(v => v + 1); void api.volumes().then(volumes => setBoot(previous => previous ? { ...previous, volumes } : previous)).catch(() => {}); }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState('');
  const operationLock = useRef(false);
  const [toast, setToast] = useState('');
  const [clipboard, setClipboard] = useState<ClipboardInfo>({ paths: [], cut: false });
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const crumbRequest = useRef(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const vcsStatus = vcsEnabled && vcs?.directory === location && !submittedQuery ? vcs.status : null;
  useEffect(() => {
    if (!boot || !vcsEnabled || isVirtual(location) || submittedQuery) { setVcs(null); return; }
    let live = true; let busy = false; let repository = false;
    const update = async (force = false) => {
      if (!live || busy) return;
      busy = true;
      try {
        const status = await api.vcsStatus(location, force);
        if (live) {
          repository = !!status && !status.error;
          setVcs(previous => {
            if (!status) return null;
            if (previous?.directory === location && JSON.stringify(previous.status) === JSON.stringify(status)) return previous;
            return { directory: location, status };
          });
        }
      } catch { if (live) setVcs(null); }
      finally { busy = false; }
    };
    const focus = () => { void update(true); };
    void update(true);
    // shortcut: refresh active repositories every five seconds; use native repository events if measured scans become costly.
    const timer = setInterval(() => { if (repository && document.hasFocus() && document.visibilityState === 'visible') void update(); }, 5000);
    window.addEventListener('focus', focus);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [boot, location, submittedQuery, refresh, vcsEnabled]);
  useEffect(() => {
    const sync = () => { void api.captureShortcut(!!modal || isEditing(document.activeElement)).catch(() => {}); };
    const blur = () => queueMicrotask(sync);
    sync(); document.addEventListener('focusin', sync); document.addEventListener('focusout', blur);
    return () => { document.removeEventListener('focusin', sync); document.removeEventListener('focusout', blur); };
  }, [modal]);
  const [modalValue, setModalValue] = useState('');
  const [modalError, setModalError] = useState('');
  const [editingName, setEditingName] = useState<{ path: string; name: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const tabHover = useRef<{ id: string; timer: number } | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loadedLocation = useRef('');
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [revealedPaths, setRevealedPaths] = useState<string[]>([]);
  const pendingSelection = useRef<{ directory: string; paths: string[] } | null>(null);

  useEffect(() => {
    const receive = () => api.takeOpenPaths().then(paths => { if (paths.length) setOpenPaths(previous => [...previous, ...paths]); }).catch(e => setToast(errorMessage(e)));
    const unsubscribe = api.onOpenPaths(receive);
    void receive();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!boot || !openPaths.length || modal || operation || editingName) return;
    let live = true;
    Promise.all(openPaths.map(p => api.info(p).catch(e => { if (live) setToast(errorMessage(e)); return null; }))).then(results => {
      if (!live) return;
      const targets = results.filter((entry): entry is FileEntry => entry !== null);
      setOpenPaths(previous => previous.slice(openPaths.length));
      if (!targets.length) return;
      const directoryFor = (entry: FileEntry) => entry.isDirectory && !entry.name.endsWith('.app') ? entry.path : parent(entry.path);
      const directory = directoryFor(targets[targets.length - 1]);
      const nextTabs = [...tabs];
      for (const entry of targets) if (!nextTabs.some(t => t.location === directoryFor(entry))) nextTabs.push(makeTab(directoryFor(entry)));
      resetNavigation();
      const paths = targets.filter(e => directoryFor(e) === directory && e.path !== directory).map(e => e.path);
      pendingSelection.current = { directory, paths };
      setRevealedPaths(paths); setTabs(nextTabs); setActiveID(nextTabs.find(t => t.location === directory)!.id);
      setRefresh(value => value + 1);
    });
    return () => { live = false; };
  }, [boot, openPaths, modal, operation, editingName, tabs]);

  useEffect(() => { migrateFolderViews().catch(e => setError(errorMessage(e))).then(() => api.bootstrap()).then(data => {
    applyLanguage(data.language); setBoot(data); setTheme(data.theme);
    setFolderViewDefaults(data.folderViews.defaults); setFolderViews(data.folderViews.overrides);
    if (!stored('finderQuickAccessOrder', false)) {
      const defaults = data.places.filter(place => ['applications', 'desktop', 'download', 'document'].includes(place.icon)).map(place => place.path);
      setPlaceOrder(previous => [...defaults, ...previous.filter(path => !defaults.includes(path))]);
      localStorage.setItem('finderQuickAccessOrder', 'true');
    }
    const saved = stored<unknown>('tabs', []);
    const folders = Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string' && ([PC, AIRDROP, NETWORK].includes(p) || isTrashLocation(p) || p.startsWith('/'))) : [];
    const initial = data.initialTab ? [{ ...data.initialTab, id: crypto.randomUUID() }] : (data.initialPath ? [data.initialPath] : [...new Set([data.home, ...folders])].slice(0, 12)).map(makeTab);
    setTabs(initial); setActiveID(initial[0].id);
    void api.windowReady();
  }).catch(e => { setError(errorMessage(e)); setLoading(false); }); }, []);
  useEffect(() => { for (const [key, value] of Object.entries({ hidden, extensions, details, previewPane, navigationPane, compact, checkboxes, pins, unpinnedDefaults, placeOrder, recent, typedPaths })) localStorage.setItem(key, JSON.stringify(value)); }, [hidden, extensions, details, previewPane, navigationPane, compact, checkboxes, pins, unpinnedDefaults, placeOrder, recent, typedPaths]);
  useEffect(() => { if (boot) localStorage.setItem('tabs', JSON.stringify(tabs.map(t => t.location))); }, [tabs, boot]);
  // Animate the existing surface, preserving focus, selection, and scroll state.
  useEffect(() => {
    if (loading || loadedLocation.current !== location) return;
    const surface = contentRef.current?.querySelector<HTMLElement>('.file-items, .computer-content, .empty-state, .connection-page');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!surface || reduced.matches) return;
    const animation = surface.animate([{ opacity: .65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
      duration: 167, easing: 'cubic-bezier(0, 0, 0, 1)',
    });
    const cancel = () => animation.cancel();
    reduced.addEventListener('change', cancel);
    return () => { cancel(); reduced.removeEventListener('change', cancel); };
  }, [loading, location, activeID, view]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!boot) return;
    const version = ++generation.current;
    setLoading(loadedLocation.current !== location || !!submittedQuery); setError(''); setSearchNote('');
    const load = async () => {
      if (location === AIRDROP || location === NETWORK) return [];
      if (isTrashLocation(location)) {
        const result = await api.listTrash(location === TRASH ? undefined : location.slice(6));
        if (version === generation.current) {
          setTrashRoots(result.roots);
          if (result.unavailable.length) setError(tr('部分回收站无法读取。请检查系统设置 → 隐私与安全性 → 完全磁盘访问权限。'));
          if (submittedQuery) setSearchNote(tr('搜索当前回收站位置'));
        }
        return result.entries.filter(entry => !submittedQuery || entry.name.toLocaleLowerCase().includes(submittedQuery.toLocaleLowerCase()));
      }
      if (submittedQuery) {
        const result = await api.search(isVirtual(location) ? boot.home : location, submittedQuery, hidden);
        if (version === generation.current) setSearchNote([result.truncated ? tr('已达到搜索上限，请缩小范围（最多 1,000 个结果 / 30,000 个项目）') : '', result.skipped ? tr('{0} 个位置无法访问', result.skipped) : ''].filter(Boolean).join(' · '));
        return result.entries;
      }
      if (location === PC) return [];
      const forceIcons = refreshIcons.current; refreshIcons.current = false;
      return (await api.list(location, forceIcons)).entries;
    };
    load().then(items => {
      if (version !== generation.current) return;
      loadedLocation.current = location; setEntries(items);
      const reveal = pendingSelection.current?.directory === location ? pendingSelection.current : null;
      if (reveal) pendingSelection.current = null;
      setSelected(previous => new Set((reveal ? reveal.paths : [...previous]).filter(p => items.some(e => e.path === p))));
    }).catch(e => { if (version === generation.current) { setEntries([]); setError(errorMessage(e)); } }).finally(() => { if (version === generation.current) setLoading(false); });
    return () => { generation.current++; api.cancelSearch().catch(() => {}); };
  }, [boot, location, refresh, submittedQuery, hidden]);
  useEffect(() => {
    if (!boot) return;
    api.watch(isVirtual(location) || submittedQuery ? null : location).catch(() => {});
    return api.onDirectoryChange(() => setRefresh(v => v + 1));
  }, [boot, location, submittedQuery]);
  useEffect(() => {
    const update = () => api.clipboardGet().then(setClipboard).catch(() => {});
    update(); window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  }, []);

  const places = useMemo<Place[]>(() => {
    const rank = (path: string) => { const index = placeOrder.indexOf(path); return index < 0 ? placeOrder.length : index; };
    return [...(boot?.places || []).filter(place => !unpinnedDefaults.includes(place.path)), ...pins.filter(p => p !== TRASH && !boot?.places.some(place => place.path === p)).map(p => ({ path: p, name: base(p), icon: p === '/Applications' || p === `${boot?.home}/Applications` ? 'applications' : 'folder' }))]
      .sort((a, b) => rank(a.path) - rank(b.path));
  }, [boot, pins, unpinnedDefaults, placeOrder]);
  const label = useCallback((value: string) => value === '/Applications' || value === `${boot?.home}/Applications` ? tr('应用程序') : value === TRASH ? tr('回收站') : value === AIRDROP ? tr('隔空投送') : value === NETWORK ? tr('网络') : value.startsWith('trash:') ? base(value.slice(6)) : value === PC ? tr('此电脑') : !value || value === boot?.home ? tr('个人文件夹') : boot?.places.find(p => p.path === value)?.name || places.find(p => p.path === value)?.name || base(value), [boot, places, language.locale]);
  const folderIcon = (value: string) => boot?.places.find(place => place.path === value)?.icon || (value === `${boot?.home}/Applications` ? 'applications' : undefined);
  const displayName = (entry: FileEntry) => entry.isDirectory && /\.app$/i.test(entry.name) ? entry.name.slice(0, -4) : extensions || entry.isDirectory || !entry.extension ? entry.name : entry.name.slice(0, -(entry.extension.length + 1));
  const visible = useMemo(() => {
    const items = entries.filter(e => hidden || !e.hidden || revealedPaths.includes(e.path));
    return items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const comparison = sort === 'name' ? a.name.localeCompare(b.name, getLocale(), { numeric: true, sensitivity: 'base' }) : sort === 'modified' ? a.modified - b.modified : sort === 'size' ? a.size - b.size : type(a).localeCompare(type(b), getLocale());
      return (ascending ? 1 : -1) * (comparison || a.name.localeCompare(b.name));
    });
  }, [entries, hidden, revealedPaths, location, submittedQuery, sort, ascending, language.locale]);
  useEffect(() => {
    if (!loading && revealedPaths.length) contentRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [loading, entries, revealedPaths]);
  const chosen = visible.filter(e => selected.has(e.path));
  const single = chosen.length === 1 ? chosen[0] : null;
  // Like Windows: the selected folder, or the current folder when nothing is selected.
  const pinTarget = selected.size ? (single?.isDirectory && !/\.app$/i.test(single.name) && !viewingTrash ? single.path : null) : !isVirtual(location) ? location : null;
  const writable = !isVirtual(location) && !submittedQuery;
  useEffect(() => {
    let live = true; setPreview(null);
    if ((details || previewPane) && single) api.preview(single.path).then(value => { if (live) setPreview(value); }).catch(() => { if (live) setPreview({ kind: 'none', content: '' }); });
    return () => { live = false; };
  }, [details, previewPane, single?.path, single?.modified]);

  function toggleDetails(value = !details) { setDetails(value); if (value) setPreviewPane(false); }
  function togglePreview() { setPreviewPane(!previewPane); if (!previewPane) setDetails(false); }
  function resetNavigation() { crumbRequest.current++; pendingSelection.current = null; setRevealedPaths([]); setSelected(new Set()); selectionAnchor.current = null; setQuery(''); setSubmittedQuery(''); setEditingAddress(false); setEditingName(null); setPopup(null); }
  function navigate(destination: string) {
    resetNavigation();
    setTabs(previous => previous.map(t => t.id === tab.id ? { ...t, location: destination, history: [...t.history.slice(0, t.index + 1), destination], index: t.index + 1 } : t));
  }
  function historyGo(offset: number) {
    const index = tab.index + offset;
    if (index < 0 || index >= tab.history.length) return;
    resetNavigation(); setTabs(previous => previous.map(t => t.id === tab.id ? { ...t, index, location: t.history[index] } : t));
  }
  function goParent() {
    if (location.startsWith('trash:')) {
      const next = parent(location.slice(6));
      navigate(trashRoots.includes(next) ? TRASH : 'trash:' + next);
    } else if (!isVirtual(location) && location !== '/') navigate(parent(location));
  }
  function newTab(destination = boot?.home || '') { const next = makeTab(destination); setTabs(previous => [...previous, next]); setActiveID(next.id); resetNavigation(); }
  function selectTab(index: number) {
    const next = tabs[index];
    if (!next || next.id === tab.id) return;
    setActiveID(next.id); resetNavigation();
    document.querySelectorAll<HTMLElement>('.tabs [role="tab"]')[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const tabDrag = useRef<{ id: string; y: number; top: number; bottom: number } | null>(null);
  const detaching = useRef(false);
  const suppressTabClick = useRef(false);
  function startTabDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || detaching.current || operation || modal || editingName) return;
    const bounds = event.currentTarget.closest('.tab-strip')!.getBoundingClientRect();
    tabDrag.current = { id, y: event.clientY, top: bounds.top, bottom: bounds.bottom };
    suppressTabClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  async function moveTabDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = tabDrag.current;
    if (!drag || detaching.current) return;
    event.currentTarget.style.transform = `translateY(${Math.max(-20, Math.min(20, event.clientY - drag.y))}px)`;
    if (Math.abs(event.clientY - drag.y) < 24 || (event.clientY >= drag.top - 16 && event.clientY <= drag.bottom + 16)) return;
    tabDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.style.transform = '';
    const target = tabs.find(t => t.id === drag.id);
    if (!target) return;
    suppressTabClick.current = true; detaching.current = true;
    try {
      await api.detachTab(target, { x: event.screenX, y: event.screenY }, tabs.length === 1);
      if (tabs.length > 1) closeTab(target.id);
    } catch (error) { setError(errorMessage(error)); }
    finally { detaching.current = false; }
  }
  function closeTab(id: string) {
    if (tabs.length === 1) { void api.closeWindow().catch(error => setError(errorMessage(error))); return; }
    const index = tabs.findIndex(t => t.id === id);
    if (id === tab.id) { setActiveID(tabs[index === 0 ? 1 : index - 1].id); resetNavigation(); }
    setTabs(previous => previous.filter(t => t.id !== id));
  }
  async function run(title: string, action: () => Promise<unknown>, success?: string): Promise<boolean> {
    if (operationLock.current) return false;
    operationLock.current = true; setOperation(title); setError('');
    try { await action(); if (success) setToast(success); return true; }
    catch (e) { setError(errorMessage(e)); return false; }
    finally { operationLock.current = false; setOperation(''); api.history().then(setUndoLabel).catch(() => {}); }
  }
  function report(result: OperationResult, verb: string) {
    if (result.succeeded.length) setToast(tr('{0} {1} 个项目', verb, result.succeeded.length));
    if (result.errors.length) setError(result.errors.slice(0, 3).map(e => `${base(e.path)}：${e.message}`).join('\n') + (result.errors.length > 3 ? tr('\n另有 {0} 项未完成。', result.errors.length - 3) : ''));
    setRefresh(v => v + 1);
  }
  function openEntry(entry: FileEntry) {
    if (viewingTrash) {
      if (entry.isDirectory && !entry.name.endsWith('.app')) navigate('trash:' + entry.path);
      else run(tr('正在预览…'), () => api.quickLook(entry.path));
      return;
    }
    if (entry.isDirectory && !entry.name.endsWith('.app')) navigate(entry.path);
    else run(tr('正在打开…'), () => openFile(entry));
  }
  async function openFile(entry: FileEntry) {
    const archive = await api.open(entry.path);
    if (archive) showModal({ kind: 'archive', archive });
    setRecent(previous => [entry.path, ...previous.filter(p => p !== entry.path)].slice(0, 30));
  }
  function copy(cut: boolean, paths = [...selected]) {
    if (!paths.length || viewingTrash && cut) return;
    run(cut ? tr('正在剪切…') : tr('正在复制…'), async () => { setClipboard(await api.clipboardSet(paths, cut)); }, tr('已{0} {1} 个项目，请到目标文件夹粘贴', cut ? tr('剪切') : tr('复制'), paths.length));
  }
  function paste(move = false) { if (writable) run(tr('正在粘贴…'), async () => { report(await api.paste(location, move), move ? tr('已移动') : tr('已粘贴')); setClipboard(await api.clipboardGet()); }); }
  function undo() { if (!viewingTrash && undoLabel) run(tr('正在撤销…'), async () => report(await api.undo(), tr('已撤销'))); }
  function showModal(next: Modal) { crumbRequest.current++; setPopup(null); setModalError(''); setModal(next); setModalValue('name' in next ? next.name : ''); }
  function create(kind: 'folder' | 'txt' | 'docx' | 'xlsx' | 'pptx') {
    if (!writable) return;
    run(tr('正在新建…'), async () => {
      const directory = kind === 'folder';
      const stem = { folder: tr('新建文件夹'), txt: tr('新建文本文档'), docx: tr('新建 Word 文档'), xlsx: tr('新建 Excel 工作簿'), pptx: tr('新建 PowerPoint 演示文稿') }[kind];
      const ext = directory ? '' : `.${kind}`;
      let name = stem + ext; let index = 2;
      while (entries.some(e => e.name === name)) name = `${stem} (${index++})${ext}`;
      const path = await api.create(location, name, directory);
      const entry = await api.info(path);
      setEntries(previous => [...previous.filter(e => e.path !== path), entry]);
      setSelected(new Set([path])); setEditingName({ path, name });
    });
  }
  const newMenu: MenuItem[] = [
    { label: tr('文件夹'), icon: <FolderPlus/>, shortcut: shortcutHint('new-folder'), action: () => create('folder') },
    { label: tr('文本文档'), icon: <FilePlus2/>, action: () => create('txt') },
    { label: tr('Word 文档'), icon: <FileText/>, action: () => create('docx') },
    { label: tr('Excel 工作簿'), icon: <Sheet/>, action: () => create('xlsx') },
    { label: tr('PowerPoint 演示文稿'), icon: <Presentation/>, action: () => create('pptx') },
  ];
  function rename(entry = single) { if (entry && !viewingTrash) { setPopup(null); setEditingName({ path: entry.path, name: entry.name }); } }
  async function finishRename(name: string) {
    if (!editingName || operationLock.current) return;
    const editing = editingName;
    if (name === editing.name) { setEditingName(null); contentRef.current?.focus(); return; }
    const success = await run(tr('正在重命名…'), async () => {
      const destination = await api.rename(editing.path, name);
      const entry = await api.info(destination);
      setEntries(previous => previous.map(e => e.path === editing.path ? entry : e));
      setSelected(new Set([destination]));
      setRecent(previous => previous.map(p => p === editing.path ? destination : p));
      setPins(previous => previous.map(p => p === editing.path ? destination : p));
    }, tr('已重命名'));
    if (success) { setEditingName(null); contentRef.current?.focus(); }
  }
  async function moveToTrash(paths: string[]) {
    report(await api.trash(paths), tr('已移到回收站'));
    setSelected(new Set());
  }
  function trash(paths = [...selected]) {
    if (!paths.length || operationLock.current || viewingTrash) return;
    if (stored('skipTrashConfirmation', false)) void run(tr('正在移到回收站…'), () => moveToTrash(paths));
    else showModal({ kind: 'trash', paths });
  }
  function ejectVolume(volume: Volume) {
    void run(tr('正在推出“{0}”…', volume.name), async () => {
      const volumes = await api.ejectVolume(volume.path);
      const removed = (boot?.volumes || []).filter(old => !volumes.some(next => next.path === old.path));
      const unavailable = (value: string) => removed.some(old => value === old.path || value.startsWith(old.path + '/'));
      const home = boot?.home || '/';
      setBoot(previous => previous ? { ...previous, volumes } : previous);
      setTabs(previous => previous.map(tab => {
        if (!unavailable(tab.location) && !tab.history.some(unavailable)) return tab;
        const remaining = tab.history.filter(value => !unavailable(value));
        const current = unavailable(tab.location) ? home : tab.location;
        const index = unavailable(tab.location) ? -1 : tab.history.slice(0, tab.index + 1).filter(value => !unavailable(value)).length - 1;
        return { ...tab, location: current, history: index < 0 ? [...remaining, current] : remaining, index: index < 0 ? remaining.length : index };
      }));
      if (unavailable(location)) resetNavigation();
      setRefresh(value => value + 1);
    }, tr('已推出“{0}”', volume.name));
  }
  useEffect(() => {
    const refreshVolumes = () => { void api.volumes().then(volumes => setBoot(previous => previous ? { ...previous, volumes } : previous)).catch(() => {}); };
    window.addEventListener('focus', refreshVolumes);
    return () => window.removeEventListener('focus', refreshVolumes);
  }, []);
  function restoreTrash(paths = [...selected], choose = false) {
    if (!paths.length) return;
    void run(tr('正在还原…'), async () => {
      setTrashOperationError('');
      const result = await api.restoreTrash(paths, choose);
      if (result) { setTrashOperationError(result.errors.map(item => `${base(item.path)}：${item.message}`).join('\n')); report(result, tr('已还原')); setSelected(new Set()); }
    });
  }
  function clearTrash() {
    void run(tr('正在清空回收站…'), async () => {
      setTrashOperationError('');
      const result = await api.emptyTrash();
      if (result) { setTrashOperationError(result.errors.map(item => `${base(item.path)}：${item.message}`).join('\n')); report(result, tr('已永久删除')); setSelected(new Set()); navigate(TRASH); }
    });
  }
  async function submitModal(skipTrashConfirmation = false) {
    if (!modal || (modal.kind === 'archive' || modal.kind === 'settings' || modal.kind === 'vcs') || operationLock.current) return;
    operationLock.current = true; setOperation(tr('正在处理…')); setModalError('');
    try {
      if (modal.kind === 'trash') {
        await moveToTrash(modal.paths);
        if (skipTrashConfirmation) localStorage.setItem('skipTrashConfirmation', 'true');
      }
      else {
        const result = modal.kind === 'rename' ? await api.rename(modal.path, modalValue) : await api.create(modal.path, modalValue, modal.kind === 'folder');
        setSelected(new Set([result])); setRefresh(v => v + 1);
        setToast(modal.kind === 'rename' ? tr('已重命名') : tr('已新建'));
      }
      setModal(null); contentRef.current?.focus();
    } catch (e) { setModalError(errorMessage(e)); }
    finally { operationLock.current = false; setOperation(''); api.history().then(setUndoLabel).catch(() => {}); }
  }
  function togglePin(path: string) {
    const pinned = places.some(place => place.path === path);
    if (boot?.places.some(place => place.path === path)) {
      setUnpinnedDefaults(previous => pinned ? [...new Set([...previous, path])] : previous.filter(p => p !== path));
      setPins(previous => previous.filter(p => p !== path));
    } else setPins(previous => pinned ? previous.filter(p => p !== path) : [...new Set([...previous, path])]);
    if (!pinned) setPlaceOrder(previous => previous.filter(p => p !== path));
  }
  // Reordering splits a row at its middle. Pinning a dragged folder only uses
  // the row edges; the centre keeps the regular move-into-folder drop.
  function placeInsertion(event: React.DragEvent, path: string) {
    const reorder = isPlaceDrag(event);
    if (!reorder && !event.dataTransfer.types.includes(FOLDERS_TYPE)) return null;
    const row = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - row.top; const zone = row.height / (reorder ? 2 : 4);
    const after = y >= row.height - zone;
    if (!after && y >= zone) return null;
    const node = (event.currentTarget.closest('.tree-node') ?? event.currentTarget).getBoundingClientRect();
    const section = event.currentTarget.closest('.sidebar-section')!.getBoundingClientRect();
    return { index: places.findIndex(place => place.path === path) + (after ? 1 : 0), top: (after ? node.bottom : node.top) - section.top };
  }
  function placeDragOver(event: React.DragEvent, path: string) {
    const next = placeInsertion(event, path);
    setPlaceMarker(previous => previous?.index === next?.index && previous?.top === next?.top ? previous : next);
    if (!next) return false;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'move'; // File-list drags only allow move.
    return true;
  }
  function dropPlace(event: React.DragEvent, path: string) {
    const insertion = placeInsertion(event, path);
    setPlaceMarker(null);
    if (!insertion) return false;
    event.preventDefault(); event.stopPropagation();
    let moved: string[];
    try { moved = isPlaceDrag(event) ? [event.dataTransfer.getData(PLACE_TYPE)] : JSON.parse(event.dataTransfer.getData('application/x-explorer-paths')); } catch { return true; }
    if (!Array.isArray(moved) || !moved.length || moved.length > 10000 || !moved.every(p => typeof p === 'string' && !p.includes('\0') && p.startsWith('/'))) return true;
    moved = [...new Set(moved)];
    const insert = () => {
      const defaults = boot?.places.map(place => place.path) || [];
      setPins(previous => [...new Set([...previous, ...moved.filter(p => !defaults.includes(p))])]);
      setUnpinnedDefaults(previous => previous.filter(p => !moved.includes(p)));
      const order = places.map(place => place.path);
      const rest = (paths: string[]) => paths.filter(p => !moved.includes(p));
      setPlaceOrder([...rest(order.slice(0, insertion.index)), ...moved, ...rest(order.slice(insertion.index))]);
    };
    if (isPlaceDrag(event)) { if (moved.every(p => places.some(place => place.path === p))) insert(); }
    else void Promise.all(moved.map(p => api.info(p))).then(entries => {
      if (entries.every(entry => entry.isDirectory && !/\.app$/i.test(entry.name) && !trashRoots.some(root => entry.path === root || entry.path.startsWith(root + '/')))) insert();
    }).catch(error => setError(errorMessage(error)));
    return true;
  }
  function chooseFolder() { run(tr('选择文件夹…'), async () => { const path = await api.chooseFolder(); if (path) navigate(path); }); }
  function terminalItem(directory: string): MenuItem {
    return { label: tr('在此处打开终端'), icon: <Terminal/>, disabled: isVirtual(directory), action: () => run(tr('正在打开终端…'), () => api.openTerminal(directory)) };
  }
  useEffect(() => () => cancelMarquee.current?.(), [location, view, loading]);
  function startMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    suppressMarqueeClick.current = false;
    const area = event.currentTarget;
    const bounds = area.getBoundingClientRect();
    if (event.button !== 0 || !event.isPrimary || loading || modal || editingName ||
      (event.target as Element).closest('.file-row, .table-heading, button, input') ||
      event.clientX >= bounds.left + area.clientWidth || event.clientY >= bounds.top + area.clientHeight ||
      connectionPage || (location === PC && !submittedQuery)) return;
    event.preventDefault(); area.focus({ preventScroll: true }); setPopup(null);
    const original = new Set(selected);
    const originalAnchor = selectionAnchor.current;
    const toggle = event.metaKey || event.ctrlKey;
    const additive = toggle || event.shiftKey;
    const start = { x: event.clientX - bounds.left + area.scrollLeft, y: event.clientY - bounds.top + area.scrollTop };
    let pointer = { x: event.clientX, y: event.clientY };
    let dragged = false; let frame = 0; let finished = false;
    // Keep label expansion from moving the hit targets while the rectangle changes.
    area.classList.add('marquee-selecting');
    const rows = [...area.querySelectorAll<HTMLElement>('.file-row')].map(row => {
      const rect = row.getBoundingClientRect();
      return { path: row.dataset.path!, left: rect.left - bounds.left + area.scrollLeft, top: rect.top - bounds.top + area.scrollTop, width: rect.width, height: rect.height };
    });
    if (!additive) { setSelected(new Set()); selectionAnchor.current = null; }
    area.setPointerCapture(event.pointerId);
    function update() {
      if (finished || !dragged) return;
      const rect = area.getBoundingClientRect();
      const x = Math.max(0, Math.min(area.clientWidth, pointer.x - rect.left));
      const y = Math.max(0, Math.min(area.clientHeight, pointer.y - rect.top));
      const speed = (position: number, limit: number) => position < 24 ? -12 : position > limit - 24 ? 12 : 0;
      area.scrollLeft += speed(x, area.clientWidth); area.scrollTop += speed(y, area.clientHeight);
      const endX = x + area.scrollLeft; const endY = y + area.scrollTop;
      const left = Math.min(start.x, endX); const top = Math.min(start.y, endY);
      const right = Math.max(start.x, endX); const bottom = Math.max(start.y, endY);
      setSelectionBox({ left, top, width: right - left, height: bottom - top });
      const next = new Set(additive ? original : []);
      for (const row of rows) {
        if (row.left < right && row.left + row.width > left && row.top < bottom && row.top + row.height > top) {
          if (toggle && original.has(row.path)) next.delete(row.path); else next.add(row.path);
        }
      }
      setSelected(previous => previous.size === next.size && [...previous].every(p => next.has(p)) ? previous : next);
      frame = requestAnimationFrame(update);
    }
    function move(e: PointerEvent) {
      if (e.pointerId !== event.pointerId) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!dragged && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) >= 4) {
        dragged = true; suppressMarqueeClick.current = true; update();
      }
    }
    function finish(cancelled = false) {
      if (finished) return;
      finished = true; cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', abort);
      window.removeEventListener('keydown', escape, true);
      if (area.hasPointerCapture(event.pointerId)) area.releasePointerCapture(event.pointerId);
      area.classList.remove('marquee-selecting'); setSelectionBox(null); cancelMarquee.current = null;
      if (cancelled) { setSelected(original); selectionAnchor.current = originalAnchor; }
    }
    function up(e: PointerEvent) { if (e.pointerId === event.pointerId) { cancelAnimationFrame(frame); update(); finish(); } }
    function abort() { finish(true); }
    function cancel(e: PointerEvent) { if (e.pointerId === event.pointerId) abort(); }
    function escape(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); abort(); } }
    cancelMarquee.current = () => finish();
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', abort);
    window.addEventListener('keydown', escape, true);
  }
  function select(entry: FileEntry, event: MouseEvent) {
    setPopup(null); contentRef.current?.focus();
    if (event.shiftKey && selectionAnchor.current) {
      const start = visible.findIndex(e => e.path === selectionAnchor.current); const end = visible.indexOf(entry);
      if (start >= 0) { const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1).map(e => e.path); setSelected(new Set(event.metaKey || event.ctrlKey ? [...selected, ...range] : range)); return; }
    }
    if (event.metaKey || event.ctrlKey) setSelected(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
    else setSelected(new Set([entry.path]));
    selectionAnchor.current = entry.path;
  }
  function menuAt(event: MouseEvent, items: MenuItem[], quickActions?: MenuItem[]) { event.preventDefault(); event.stopPropagation(); setPopup({ x: event.clientX, y: event.clientY, items, quickActions }); }
  function buttonMenu(event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) { const rect = event.currentTarget.getBoundingClientRect(); setPopup(popup ? null : { x: rect.left, y: rect.bottom + 5, items }); }
  function share(paths: string[], position: { x: number; y: number }) {
    void run(tr('正在读取共享方式…'), async () => {
      const services = await api.shareServices(paths);
      if (!services.length) throw new Error(tr('当前没有可用的共享方式。'));
      setPopup({ ...position, items: services.map(service => ({
        label: service.title,
        icon: service.icon ? <img src={service.icon} width={16} height={16} alt=""/> : <Share2/>,
        action: () => { void run(tr('共享文件…'), () => api.share(paths, service.title)); },
      })) });
    });
  }
  function contextMenu(event: MouseEvent, entry?: FileEntry) {
    event.stopPropagation();
    const paths = entry && !selected.has(entry.path) ? [entry.path] : [...selected];
    if (entry && !selected.has(entry.path)) setSelected(new Set([entry.path]));
    if (viewingTrash) {
      menuAt(event, [
        ...(entry ? [{ label: tr('还原'), disabled: !!operation, action: () => restoreTrash(paths) }, { label: tr('还原到…'), disabled: !!operation, action: () => restoreTrash(paths, true) }] : []),
        { label: tr('清空回收站…'), icon: <Trash2/>, disabled: !!operation, action: clearTrash },
        ...(entry ? [{ label: entry.isDirectory ? tr('打开') : tr('快速查看'), icon: <FolderOpen/>, action: () => openEntry(entry) }, { label: tr('复制'), icon: <Copy/>, action: () => copy(false, paths) }] : []),
        { label: tr('刷新'), icon: <RotateCw/>, action: refreshDirectory },
        { label: hidden ? tr('不显示隐藏项目') : tr('显示隐藏的项目'), checked: hidden, action: () => setHidden(v => !v) },
      ]);
      return;
    }
    const target = paths.length === 1 ? entry || single : null;
    const items: MenuItem[] = entry ? [
      { label: tr('打开'), icon: <FolderOpen/>, shortcut: shortcutHint('open'), action: () => openEntry(entry) },
      ...(!entry.isDirectory ? [{ label: tr('打开方式…'), icon: <ExternalLink/>, disabled: paths.some(p => visible.find(item => item.path === p)?.isDirectory), action: () => run(tr('选择打开方式…'), async () => {
        if (await api.openWith(paths)) setRecent(previous => [...paths, ...previous.filter(p => !paths.includes(p))].slice(0, 30));
      }) }, { label: tr('使用文本编辑'), icon: <FileText/>, disabled: paths.some(p => visible.find(item => item.path === p)?.isDirectory), action: () => run(tr('正在使用文本编辑打开…'), async () => {
        if (await api.openWith(paths, 'textedit')) setRecent(previous => [...paths, ...previous.filter(p => !paths.includes(p))].slice(0, 30));
      }) }] : []),
      ...(!entry.isDirectory && isArchive(entry.path) ? ([['choose', tr('解压到…')], ['here', tr('解压到当前目录')], ['folder', tr('解压到“{0}/”', archiveFolderName(entry.name))]] as const).map(([mode, label]) => ({ label, icon: <Download/>, disabled: paths.length !== 1, action: () => run(tr('正在解压…'), async () => {
        const result = await api.extractArchive(entry.path, null, mode); if (result) report(result, tr('已解压'));
      }) })) : []),
      ...(entry.isDirectory ? [{ label: tr('在新标签页中打开'), icon: <Plus/>, action: () => newTab(entry.path) }] : [{ label: tr('快速查看'), icon: <Search/>, shortcut: shortcutHint('quick-look'), action: () => run(tr('正在预览…'), () => api.quickLook(entry.path)) }]),
      ...(entry.isDirectory ? [terminalItem(entry.path)] : []),
      { label: tr('压缩为 ZIP'), icon: <Archive/>, action: () => run(tr('正在压缩…'), async () => {
        const output = await api.compressArchive(paths);
        report({ succeeded: [output], errors: [] }, tr('已压缩'));
        setSelected(new Set([output])); setToast(tr('已创建 {0}', base(output)));
      }) },
      { label: tr('剪切'), icon: <Scissors/>, shortcut: shortcutHint('cut'), divider: true, action: () => copy(true, paths) },
      { label: tr('复制'), icon: <Copy/>, shortcut: shortcutHint('copy'), action: () => copy(false, paths) },
      { label: tr('复制文件地址'), icon: <Copy/>, action: () => run(tr('复制地址…'), () => api.copyText(paths.join('\n')), tr('已复制文件地址')) },
      { label: tr('重命名'), icon: <TextCursorInput/>, shortcut: shortcutHint('rename'), disabled: paths.length !== 1, action: () => rename(target) },
      { label: tr('移到回收站'), icon: <Trash2/>, shortcut: shortcutHint('trash'), danger: true, action: () => trash(paths) },
      ...(entry.isDirectory ? [{ label: places.some(place => place.path === entry.path) ? tr('从快速访问取消固定') : tr('固定到快速访问'), icon: <Pin/>, divider: true, action: () => togglePin(entry.path) }] : []),
      { label: tr('在访达中显示'), icon: <ExternalLink/>, divider: true, action: () => run(tr('正在显示…'), () => api.reveal(entry.path)) },
      { label: tr('属性'), icon: <Info/>, shortcut: shortcutHint('details-pane'), action: () => toggleDetails(true) },
    ] : [
      { label: tr('新建'), icon: <Plus/>, disabled: !writable || !!operation, children: newMenu },
      { label: tr('粘贴'), icon: <ClipboardPaste/>, shortcut: shortcutHint('paste'), divider: true, disabled: !writable || !clipboard.paths.length, action: () => paste() },
      { label: tr('将项目移到这里'), shortcut: shortcutHint('move-here'), disabled: !writable || !clipboard.paths.length, action: () => paste(true) },
      { label: undoLabel ? tr('撤销{0}', undoLabel) : tr('撤销'), icon: <Undo2/>, shortcut: shortcutHint('undo'), disabled: !undoLabel, action: undo },
      { label: tr('刷新'), icon: <RotateCw/>, shortcut: shortcutHint('refresh'), action: refreshDirectory },
      { label: hidden ? tr('不显示隐藏项目') : tr('显示隐藏的项目'), checked: hidden, divider: true, action: () => setHidden(v => !v) },
      { label: tr('打开文件夹…'), icon: <FolderOpen/>, action: chooseFolder },
      ...(!isVirtual(location) ? [terminalItem(location)] : []),
    ];
    const quickActions: MenuItem[] | undefined = entry ? [
      { label: tr('剪切'), icon: <Scissors/>, shortcut: shortcutHint('cut'), action: () => copy(true, paths) },
      { label: tr('复制'), icon: <Copy/>, shortcut: shortcutHint('copy'), action: () => copy(false, paths) },
      { label: tr('重命名'), icon: <TextCursorInput/>, shortcut: shortcutHint('rename'), disabled: paths.length !== 1, action: () => rename(target) },
      { label: tr('共享'), icon: <Share2/>, action: () => share(paths, { x: event.clientX, y: event.clientY }) },
      { label: tr('删除'), icon: <Trash2/>, shortcut: shortcutHint('trash'), action: () => trash(paths) },
    ] : undefined;
    if (vcsStatus) items.push({ label: vcsStatus.kind === 'git' ? 'Git' : 'SVN', divider: true, disabled: !!operation, children: [
      { label: tr('查看差异…'), disabled: !!vcsStatus.error, action: () => showModal({ kind: 'vcs', directory: location, paths: entry ? paths : [location], action: 'diff' }) },
      { label: vcsStatus.kind === 'git' ? tr('暂存所选更改…') : tr('加入版本控制…'), disabled: !!vcsStatus.error, action: () => showModal({ kind: 'vcs', directory: location, paths: entry ? paths : [location], action: 'add' }) },
      { label: vcsStatus.kind === 'git' ? tr('提交已暂存更改…') : tr('提交更改…'), disabled: !!vcsStatus.error, action: () => showModal({ kind: 'vcs', directory: location, paths: entry ? paths : [location], action: 'commit' }) },
      { label: vcsStatus.kind === 'git' ? tr('拉取更新（仅快进）…') : tr('更新工作副本…'), disabled: !!vcsStatus.error, action: () => showModal({ kind: 'vcs', directory: location, paths: [vcsStatus.root], action: 'update' }) },
      { label: tr('丢弃本地修改…'), danger: true, disabled: !!vcsStatus.error, action: () => showModal({ kind: 'vcs', directory: location, paths: entry ? paths : [location], action: 'revert' }) },
      { label: tr('刷新版本状态'), action: () => setRefresh(value => value + 1) },
    ] });
    menuAt(event, entry ? items.filter(item => ![tr('剪切'), tr('复制'), tr('重命名'), tr('移到回收站')].includes(item.label)) : items, quickActions);
  }
  const sortMenu: MenuItem[] = [
    ...(['name', 'modified', 'type', 'size'] as SortKey[]).map(key => ({ label: ({ name: tr('名称'), modified: tr('修改日期'), type: tr('类型'), size: tr('大小') })[key], checked: sort === key, action: () => changeSort({ sort: key }) })),
    { label: tr('递增'), checked: ascending, divider: true, action: () => changeSort({ ascending: true }) },
    { label: tr('递减'), checked: !ascending, action: () => changeSort({ ascending: false }) },
  ];
  const viewMenu: MenuItem[] = [
    ...([{ name: tr('超大图标'), size: 128, action: 'extra-large-icons', icon: <ViewGlyph mode="extra"/> }, { name: tr('大图标'), size: 64, action: 'icons', icon: <ViewGlyph mode="large"/> }, { name: tr('中图标'), size: 48, action: 'medium-icons', icon: <ViewGlyph mode="medium"/> }, { name: tr('小图标'), size: 32, action: 'small-icons', icon: <ViewGlyph mode="small"/> }] as const).map(option => ({ label: option.name, icon: option.icon, shortcut: shortcutHint(option.action), radio: true, checked: view === 'icons' && iconSize === option.size, action: () => { changeView({ view: 'icons', iconSize: option.size }); } })),
    { label: tr('列表'), icon: <ViewGlyph mode="list"/>, shortcut: shortcutHint('list'), radio: true, checked: view === 'list', action: () => changeView({ view: 'list' }) },
    { label: tr('详细信息'), icon: <ViewGlyph mode="details"/>, shortcut: shortcutHint('details'), radio: true, checked: view === 'details', action: () => changeView({ view: 'details' }) },
    { label: tr('平铺'), icon: <ViewGlyph mode="tiles"/>, shortcut: shortcutHint('tiles'), radio: true, checked: view === 'tiles', action: () => changeView({ view: 'tiles' }) },
    { label: tr('内容'), icon: <ViewGlyph mode="content"/>, shortcut: shortcutHint('content'), radio: true, checked: view === 'content', action: () => changeView({ view: 'content' }) },
    { label: tr('详细信息窗格'), icon: <PanelRight/>, checked: details, divider: true, action: () => toggleDetails() },
    { label: tr('预览窗格'), icon: <PanelRight/>, checked: previewPane, action: togglePreview },
    { label: tr('显示'), divider: true, children: [
      { label: tr('导航窗格'), icon: <PanelLeft/>, checked: navigationPane, action: () => setNavigationPane(v => !v) },
      { label: tr('紧凑视图'), icon: <ChevronsDownUp/>, checked: compact, divider: true, action: () => setCompact(v => !v) },
      { label: tr('项目复选框'), icon: <SquareCheck/>, checked: checkboxes, divider: true, action: () => setCheckboxes(v => !v) },
      { label: tr('文件扩展名'), icon: <FileType/>, checked: extensions, action: () => setExtensions(v => !v) },
      { label: tr('隐藏的项目'), icon: <Eye/>, checked: hidden, action: () => setHidden(v => !v) },
    ] },
    { label: tr('应用到所有文件夹'), divider: true, action: () => { api.resetFolderViews({ view, iconSize, sort, ascending }).catch(error => setError(errorMessage(error))); } },
  ];
  function rememberAddress(value: string) { setTypedPaths(previous => [value, ...previous.filter(p => p !== value)].slice(0, 25)); }
  function resolveAddress(value: string) {
    let path = value;
    if (path === '~' || path.startsWith('~/')) path = boot!.home + path.slice(1);
    return path.startsWith('/') ? path : join(isVirtual(location) ? boot!.home : location, path);
  }
  async function goAddress(value = address) {
    let path = value.trim();
    if (/^smb:/i.test(path)) { if (await connectNetwork(path)) rememberAddress(path); return; }
    if (path.startsWith('file://')) { try { path = decodeURIComponent(new URL(path).pathname); } catch { setError(tr('文件地址格式不正确。')); return; } }
    path = resolveAddress(path);
    let opened = '';
    const succeeded = await run(tr('正在打开位置…'), async () => {
      const entry = await api.info(path);
      if (entry.isDirectory && !entry.name.endsWith('.app')) navigate(entry.path);
      else { await openFile(entry); setEditingAddress(false); }
      opened = entry.path;
    });
    if (succeeded && opened) rememberAddress(opened);
  }
  function addressMenu(event: MouseEvent, path: string) {
    menuAt(event, [{ label: tr('复制地址'), icon: <Copy/>, action: () => run(tr('复制地址…'), () => api.copyText(path), tr('已复制地址')) }]);
  }
  // A breadcrumb chevron lists the subfolders of the crumb before it; the leading one lists volumes.
  function crumbMenu(event: MouseEvent<HTMLButtonElement>, directory: string | null) {
    event.stopPropagation();
    const request = ++crumbRequest.current;
    if (popup) { setPopup(null); return; }
    const rect = event.currentTarget.getBoundingClientRect(); const position = { x: rect.left, y: rect.bottom + 5 };
    if (directory === null) { setPopup({ ...position, items: (boot?.volumes || []).map(volume => ({ label: volume.name, action: () => navigate(volume.path) })) }); return; }
    api.list(directory).then(listing => {
      if (request !== crumbRequest.current) return;
      const folders = listing.entries.filter(entry => entry.isDirectory && !entry.name.endsWith('.app') && (hidden || !entry.hidden)).sort((a, b) => a.name.localeCompare(b.name, getLocale(), { numeric: true }));
      setPopup({ ...position, items: folders.length ? folders.map(folder => ({ label: folder.name, action: () => navigate(folder.path) })) : [{ label: tr('没有子文件夹'), disabled: true }] });
    }).catch(error => { if (request === crumbRequest.current) setError(errorMessage(error)); });
  }
  // Typing up to a slash lists that folder's subfolders by case-insensitive prefix.
  const addressPrefix = addressQuery === null || /^(smb|file):/i.test(addressQuery.trim()) || !addressQuery.includes('/') ? null : {
    parent: addressQuery.slice(0, addressQuery.lastIndexOf('/') + 1), name: addressQuery.slice(addressQuery.lastIndexOf('/') + 1).toLowerCase(),
  };
  const addressParent = editingAddress && addressPrefix && boot ? resolveAddress(addressPrefix.parent).replace(/(.)\/+$/, '$1') : null;
  const addressSuggestions = !editingAddress ? [] : addressQuery === null ? typedPaths
    : addressPrefix && addressParent && addressFolders[addressParent] ? addressFolders[addressParent].filter(folder => (hidden || !folder.hidden) && folder.name.toLowerCase().startsWith(addressPrefix.name)).slice(0, 5).map(folder => addressPrefix.parent + folder.name) : [];
  useEffect(() => {
    if (!addressParent || addressFolders[addressParent]) return;
    let live = true;
    api.list(addressParent).then(listing => listing.entries, () => []).then(entries => {
      if (live) setAddressFolders(previous => ({ ...previous, [addressParent]: entries.filter(entry => entry.isDirectory && !entry.name.endsWith('.app')).map(entry => ({ name: entry.name, hidden: entry.hidden })).sort((a, b) => a.name.localeCompare(b.name, getLocale(), { numeric: true })) }));
    });
    return () => { live = false; };
  }, [addressParent]);
  function addressKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { setEditingAddress(false); return; }
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !addressSuggestions.length) return;
    event.preventDefault();
    const count = addressSuggestions.length;
    const next = event.key === 'ArrowDown' ? (addressActive + 1) % count : addressActive <= 0 ? count - 1 : addressActive - 1;
    setAddressActive(next); setAddress(addressSuggestions[next]);
    document.getElementById(`address-suggestion-${next}`)?.scrollIntoView({ block: 'nearest' });
  }
  function drop(event: React.DragEvent, destination: string) {
    event.preventDefault(); event.stopPropagation(); setDragOver(null);
    if (destination !== AIRDROP && isVirtual(destination) || viewingTrash && trashRoots.some(root => destination === root || destination.startsWith(root + '/'))) return;
    let paths: string[] = [];
    try { paths = JSON.parse(event.dataTransfer.getData('application/x-explorer-paths') || '[]'); } catch { /* External drop. */ }
    if (!paths.length) paths = Array.from(event.dataTransfer.files).map(file => api.filePath(file)).filter(Boolean);
    if (paths.length) {
      if (destination === AIRDROP) sendAirDrop(paths);
      else run(tr('正在移动拖入的文件…'), async () => report(await api.moveTo(paths, destination), tr('已移动')));
    }
  }

  function sendAirDrop(paths?: string[]) {
    void run(tr('正在打开隔空投送…'), async () => {
      const files = paths ?? await api.chooseAirDropFiles();
      if (files?.length) await api.airDrop(files);
    });
  }
  async function connectNetwork(address: string) {
    let connected = false;
    const succeeded = await run(tr('正在连接服务器…'), async () => {
      const mounts = await api.connectNetwork(address);
      if (!mounts) return;
      const volumes = await api.volumes();
      setBoot(previous => previous ? { ...previous, volumes } : previous);
      navigate(mounts[0]);
      connected = true;
    });
    return succeeded && connected;
  }

  const actions = useRef<(action: string) => void>(() => {});
  actions.current = action => {
    if (modal) return;
    if (action === 'settings') { showModal({ kind: 'settings' }); return; }
    if (action.startsWith('tab-') || action === 'last-tab') {
      if (!editingName) selectTab(action === 'last-tab' ? tabs.length - 1 : Number(action.slice(4)) - 1);
      return;
    }
    if (isEditing(document.activeElement)) return;
    const commands: Record<string, () => void> = {
      'choose-folder': chooseFolder,
      rename: () => rename(), open: () => { if (single) void openEntry(single); },
      copy: () => copy(false), cut: () => copy(true), paste: () => paste(), undo,
      'move-here': () => paste(true),
      duplicate: () => { if (writable && selected.size) void run(tr('正在创建副本…'), async () => report(await api.copyTo([...selected], location), tr('已创建副本'))); },
      'select-all': () => setSelected(new Set(visible.map(e => e.path))),
      'new-folder': () => create('folder'), trash: () => trash(),
      'quick-look': () => { if (single) void run(tr('正在预览…'), () => api.quickLook(single.path)); },
      back: () => historyGo(-1), forward: () => historyGo(1), parent: goParent,
      address: editAddress, search: () => { searchRef.current?.focus(); searchRef.current?.select(); },
      'new-tab': () => newTab(), 'close-tab': () => closeTab(tab.id),
      'next-tab': () => { const index = tabs.findIndex(t => t.id === tab.id); setActiveID(tabs[(index + 1) % tabs.length].id); resetNavigation(); },
      'previous-tab': () => { const index = tabs.findIndex(t => t.id === tab.id); setActiveID(tabs[(index + tabs.length - 1) % tabs.length].id); resetNavigation(); },
      'extra-large-icons': () => changeView({ view: 'icons', iconSize: 128 }),
      icons: () => changeView({ view: 'icons', iconSize: 64 }),
      'medium-icons': () => changeView({ view: 'icons', iconSize: 48 }),
      'small-icons': () => changeView({ view: 'icons', iconSize: 32 }),
      list: () => changeView({ view: 'list' }), tiles: () => changeView({ view: 'tiles' }), content: () => changeView({ view: 'content' }),
      details: () => changeView({ view: 'details' }), preview: togglePreview,
      hidden: () => setHidden(v => !v), 'details-pane': () => toggleDetails(), refresh: refreshDirectory,
    };
    commands[action]?.();
  };
  useEffect(() => api.onAction(action => actions.current(action)), []);
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      crumbRequest.current++;
      if (event.defaultPrevented || event.isComposing || modal || popup) return;
      const accelerator = shortcutFromEvent(event);
      const action = accelerator && shortcutActionIDs.find(id => bindingsFor(id, operationShortcuts).includes(accelerator));
      if (isEditing(event.target) && !(action && (action.startsWith('tab-') || action === 'last-tab') && !editingName)) {
        // Keep the existing address/search entry points without taking text-editing keys.
        if (action === 'address' && ['Control+L', 'Alt+D'].includes(accelerator!)) { event.preventDefault(); editAddress(); }
        if (action === 'search' && ['Control+F', 'Control+E'].includes(accelerator!)) { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
        return;
      }
      if (action) { event.preventDefault(); actions.current(action); return; }
      const navigation: Record<string, () => void> = {
        'Command+Shift+C': () => navigate(PC), 'Command+Shift+H': () => { if (boot) navigate(boot.home); },
        'Command+Shift+D': () => { if (boot) navigate(join(boot.home, 'Desktop')); },
        'Command+Shift+O': () => { if (boot) navigate(join(boot.home, 'Documents')); },
        'Command+Alt+L': () => { if (boot) navigate(join(boot.home, 'Downloads')); },
        'Command+Alt+S': () => setNavigationPane(v => !v),
      };
      if (accelerator && navigation[accelerator]) { event.preventDefault(); navigation[accelerator](); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') { setSelected(new Set()); setSubmittedQuery(''); setQuery(''); }
      else if (['arrowdown', 'arrowup', 'home', 'end'].includes(key) && visible.length) {
        event.preventDefault();
        const index = visible.findIndex(e => e.path === [...selected].at(-1));
        const next = key === 'home' ? 0 : key === 'end' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + (key === 'arrowdown' ? 1 : -1)));
        if (event.shiftKey) setSelected(previous => new Set([...previous, visible[next].path]));
        else setSelected(new Set([visible[next].path]));
        selectionAnchor.current = visible[next].path;
        document.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });
  useEffect(() => {
    if (editingAddress) { setAddressQuery(null); setAddressActive(-1); addressRef.current?.focus(); addressRef.current?.select(); }
    else setAddressFolders({});
  }, [editingAddress]);
  const historyNavigation = useRef({ historyGo, blocked: false, context: '' });
  historyNavigation.current = {
    historyGo, blocked: !!(modal || popup || operation || editingName || editingAddress),
    context: `${tab.id}:${tab.index}:${location}`,
  };
  useEffect(() => {
    // Wheel events include trackpad momentum. Keep the gesture latched across
    // navigation/renders until a quiet gap or a fresh stroke after the tail.
    let lastEvent = -Infinity;
    let distanceX = 0; let distanceY = 0;
    let mode: 'pending' | 'horizontal' | 'ignored' | 'done' = 'pending';
    let context = '';
    let navigatedAt = -Infinity;
    let previousX = 0;
    let tailStartedAt: number | null = null;
    let navigatedEpoch = -Infinity;
    const stopGestureListener = api.onScrollGestureStart(timestamp => {
      // Native finger-down marks a new stroke even while old momentum is still
      // arriving. Ignore a delayed signal from the stroke already navigated.
      if (timestamp <= navigatedEpoch) return;
      lastEvent = -Infinity; mode = 'pending'; tailStartedAt = null;
    });
    const swipe = (event: WheelEvent) => {
      // macOS can continue sending zero-delta phase events after fingers lift.
      // They must not keep the previous gesture alive.
      if (!event.deltaX && !event.deltaY) return;
      const current = historyNavigation.current;
      const now = performance.now();
      const x = Math.abs(event.deltaX);
      // A fresh stroke can interrupt the previous stroke's momentum without a
      // quiet gap. Rearm only after a sustained low-energy tail and a new surge.
      const freshStroke = mode === 'done' && now - navigatedAt >= 180 &&
        tailStartedAt !== null && now - tailStartedAt >= 60 &&
        x >= 8 && x >= previousX * 3 && x > Math.abs(event.deltaY) * 1.25;
      if (now - lastEvent > 250 || freshStroke) {
        distanceX = 0; distanceY = 0; mode = 'pending'; context = current.context;
        tailStartedAt = null;
      }
      lastEvent = now;
      previousX = x;
      const target = event.target instanceof Element ? event.target : null;
      const content = contentRef.current;
      const editable = (element: Element | null) => !!element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (current.blocked || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.deltaMode !== 0 ||
        !content || !target || !content.contains(target) || editable(target) || editable(document.activeElement)) {
        mode = 'ignored'; return;
      }
      if (mode === 'done') {
        if (x <= 4) tailStartedAt ??= now;
        else tailStartedAt = null;
        event.preventDefault(); return;
      }
      if (context !== current.context) mode = 'ignored';
      if (mode === 'ignored') return;
      // A horizontally scrollable list owns the entire gesture, including at
      // its edges, so scrolling to the last column never changes directories.
      if (mode === 'pending') {
        for (let element: Element | null = target; element; element = element.parentElement) {
          if (element.scrollWidth > element.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) {
            mode = 'ignored'; return;
          }
          if (element === content) break;
        }
      }
      distanceX += event.deltaX; distanceY += Math.abs(event.deltaY);
      if (mode === 'pending') {
        if (Math.max(Math.abs(distanceX), distanceY) < 10) return;
        // A diagonal start is undecided, not a rejected horizontal gesture.
        // Only lock out navigation when the stream is clearly vertical.
        if (distanceY > Math.abs(distanceX) * 1.5) { mode = 'ignored'; return; }
        if (Math.abs(distanceX) <= distanceY * 1.25) return;
        mode = 'horizontal';
      }
      event.preventDefault();
      if (Math.abs(distanceX) < 48) return;
      mode = 'done';
      navigatedAt = now; tailStartedAt = null;
      navigatedEpoch = performance.timeOrigin + event.timeStamp;
      current.historyGo(distanceX < 0 ? -1 : 1);
    };
    document.addEventListener('wheel', swipe, { passive: false });
    return () => { document.removeEventListener('wheel', swipe); stopGestureListener(); };
  }, []);
  useEffect(() => {
    // UI Events defines buttons 3/4 as Back/Forward. Mouse drivers that remap
    // them to shortcuts or gestures already reach the existing handlers.
    // Sample the guard at press time in the capture phase, before the shell's
    // pointerdown handler dismisses an open menu; by mouseup it no longer
    // applies. Preventing mousedown keeps an address or rename input focused.
    let armed = -1;
    const press = (event: PointerEvent) => {
      if (event.button === 3 || event.button === 4) armed = historyNavigation.current.blocked ? -1 : event.button;
    };
    const sideButton = (event: globalThis.MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type !== 'mouseup') return;
      if (armed === event.button && !historyNavigation.current.blocked) historyNavigation.current.historyGo(event.button === 3 ? -1 : 1);
      armed = -1;
    };
    const cancel = () => { armed = -1; };
    window.addEventListener('blur', cancel);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('mousedown', sideButton);
    window.addEventListener('mouseup', sideButton);
    return () => {
      window.removeEventListener('blur', cancel); window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('mousedown', sideButton); window.removeEventListener('mouseup', sideButton);
    };
  }, []);
  useEffect(() => {
    const element = contentRef.current;
    const zoomIcons = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      const scope = folderViewScope.current;
      const current = resolveFolderView(scope.defaults, scope.folderViews[scope.location]);
      changeView({ view: 'icons', iconSize: Math.min(128, Math.max(32, current.iconSize + (event.deltaY < 0 ? 8 : -8))) });
    };
    element?.addEventListener('wheel', zoomIcons, { passive: false });
    return () => element?.removeEventListener('wheel', zoomIcons);
  }, [location]);

  function editAddress() {
    if (editingAddress) return;
    crumbRequest.current++;
    setAddress(isVirtual(location) ? boot?.home || '/' : location); setEditingAddress(true);
  }

  const breadcrumbs = !isVirtual(location) ? [{ path: '/', name: 'Macintosh HD' }, ...location.split('/').filter(Boolean).map((part, index, parts) => ({ path: '/' + parts.slice(0, index + 1).join('/'), name: label('/' + parts.slice(0, index + 1).join('/')) }))] : [];
  const totalSelected = chosen.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0);

  function fileRows() {
    return <div className={`file-items ${view === 'icons' ? `icon-grid ${iconSize === 32 ? 'small-icons' : ''}` : view === 'details' ? 'file-table' : view === 'content' ? 'file-content-view' : `file-${view}`} ${checkboxes ? 'with-checkboxes' : ''}`} style={view === 'icons' ? { '--file-icon-size': `${iconSize}px` } as CSSProperties : undefined} role="listbox" aria-label={tr('文件列表')} aria-multiselectable="true">
      {view === 'details' && <div className="table-heading" role="presentation">
        {checkboxes && <input className="select-all-checkbox" type="checkbox" aria-label={tr('全选文件')} checked={visible.length > 0 && chosen.length === visible.length} ref={element => { if (element) element.indeterminate = chosen.length > 0 && chosen.length < visible.length; }} onChange={event => setSelected(new Set(event.target.checked ? visible.map(entry => entry.path) : []))}/>}
        {(['name', 'modified', 'type', 'size'] as SortKey[]).map(key => <button key={key} className={`col-${key}`} onClick={() => changeSort(sort === key ? { ascending: !ascending } : { sort: key, ascending: true })}>{({ name: tr('名称'), modified: tr('修改日期'), type: tr('类型'), size: tr('大小') })[key]}{sort === key && <ChevronDown size={12} className={ascending ? 'rotated' : ''}/>}</button>)}
      </div>}
      {visible.map((entry, index) => <div key={entry.path} data-path={entry.path} data-index={index} role="option" aria-selected={selected.has(entry.path)} aria-label={entry.name} aria-description={vcsStatus?.states[entry.path] ? vcsStateLabel(vcsStatus.states[entry.path]) : undefined}
        className={`file-row ${selected.has(entry.path) ? 'selected' : ''} ${clipboard.cut && clipboard.paths.includes(entry.path) ? 'cut' : ''} ${dragOver === entry.path ? 'drop-target' : ''} ${entry.hidden ? 'hidden-file' : ''}`}
        onClick={event => select(entry, event)} onDoubleClick={() => openEntry(entry)} onContextMenu={event => contextMenu(event, entry)} draggable={!viewingTrash}
        onDragStart={event => {
          const paths = selected.has(entry.path) ? [...selected] : [entry.path];
          setPopup(null);
          // Keep folder-only drags in HTML so Quick Access can identify pinning targets.
          const folders = paths.every(p => visible.some(e => e.path === p && e.isDirectory && !/\.app$/i.test(e.name)));
          if (!folders) {
            event.preventDefault();
            void api.startFileDrag(paths).catch(error => setError(errorMessage(error)));
            return;
          }
          event.dataTransfer.setData('application/x-explorer-paths', JSON.stringify(paths)); event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(FOLDERS_TYPE, '1');
        }}
        onDragOver={event => { if (entry.isDirectory && !viewingTrash && !isPlaceDrag(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDragOver(entry.path); } }}
        onDragLeave={() => setDragOver(null)} onDrop={event => { if (entry.isDirectory) drop(event, entry.path); }}>
        {checkboxes && <input className="item-checkbox" type="checkbox" aria-label={tr('选择 {0}', entry.name)} checked={selected.has(entry.path)} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onChange={event => { const checked = event.target.checked; setSelected(previous => { const next = new Set(previous); if (checked) next.add(entry.path); else next.delete(entry.path); return next; }); selectionAnchor.current = entry.path; }}/>}
        <div className="col-name"><FileGlyph entry={entry} badge={folderIcon(entry.path)} state={vcsStatus?.states[entry.path]} dimension={view === 'icons' ? iconSize : view === 'tiles' ? 48 : view === 'content' ? 56 : 22}/>{editingName?.path === entry.path ? <InlineName key={editingName.path} name={editingName.name} directory={entry.isDirectory} onSave={finishRename} onCancel={() => { setEditingName(null); contentRef.current?.focus(); }}/> : <span className="entry-name" title={entry.name}>{displayName(entry)}{(view === 'tiles' || view === 'content') && <small>{type(entry)}{!entry.isDirectory && ` · ${size(entry.size)}`}</small>}{submittedQuery && <small>{parent(entry.path)}</small>}</span>}</div>
        {view === 'content' && <div className="content-metadata"><span>{tr('修改日期：')}{date(entry.modified)}</span><span title={entry.path}>{tr('位置：')}{parent(entry.path)}</span></div>}
        {view === 'details' && <><span className="col-modified">{date(entry.modified)}</span><span className="col-type">{type(entry)}</span><span className="col-size">{entry.isDirectory ? '' : size(entry.size)}</span></>}
      </div>)}
    </div>;
  }

  const toolbarTools: Record<ToolbarAction, ToolbarTool> = {
    cut: { name: tr('剪切'), label: shortcutLabel('剪切', 'cut'), icon: <Scissors className="scissors-icon"/>, disabled: viewingTrash || !selected.size || !!operation, action: () => copy(true) },
    copy: { name: tr('复制'), label: shortcutLabel('复制', 'copy'), icon: <Copy className="copy-icon"/>, disabled: !selected.size || !!operation, action: () => copy(false) },
    paste: { name: tr('粘贴'), label: shortcutLabel('粘贴', 'paste'), icon: <ClipboardPaste/>, disabled: !writable || !clipboard.paths.length || !!operation, action: () => paste() },
    rename: { name: tr('重命名'), label: shortcutLabel('重命名', 'rename'), icon: <TextCursorInput className="rename-icon"/>, disabled: viewingTrash || !single || !!operation, action: () => rename() },
    share: { name: tr('共享'), label: tr('共享'), icon: <Share2/>, disabled: !selected.size || !!operation, action: event => { const rect = event.currentTarget.getBoundingClientRect(); share([...selected], { x: rect.left, y: rect.bottom + 5 }); } },
    trash: { name: tr('移到回收站'), label: shortcutLabel('移到回收站', 'trash'), icon: <Trash2/>, disabled: viewingTrash || !selected.size || !!operation, action: () => trash() },
    airdrop: { name: tr('隔空投送'), label: tr('隔空投送'), icon: <Radar/>, disabled: viewingTrash || !selected.size || !!operation, action: () => { void run(tr('正在打开隔空投送…'), () => api.airDrop([...selected])); } },
    terminal: { name: tr('在终端中打开'), label: tr('在终端中打开'), icon: <Terminal/>, disabled: isVirtual(location) || viewingTrash || !!operation, action: () => { void run(tr('正在打开终端…'), () => api.openTerminal(single?.isDirectory && !/\.app$/i.test(single.name) ? single.path : location)); } },
    undo: { name: tr('撤销'), label: tr('撤销'), icon: <Undo2/>, disabled: viewingTrash || !undoLabel || !!operation, action: undo },
    refresh: { name: tr('刷新'), label: shortcutLabel('刷新', 'refresh'), icon: <RotateCw/>, disabled: !!operation, action: refreshDirectory },
  };

  return <div className={`explorer-shell ${compact ? 'compact-view' : ''}`} onPointerDownCapture={() => { crumbRequest.current++; }} onPointerDown={() => { if (popup) setPopup(null); }} onDragEnd={() => { setPlaceMarker(null); clearTimeout(tabHover.current?.timer); tabHover.current = null; }}>
    <header className="tab-strip">
      <div className="traffic-light-space"/>
      <div className="tabs" role="tablist" aria-label={tr('文件夹标签页')}>
        {tabs.map(t => <div key={t.id} className={`tab ${t.id === tab.id ? 'current' : ''} ${dragOver === 'tab:' + t.id ? 'drop-target' : ''}`}
          onDragOver={event => {
            if (isVirtual(t.location)) return;
            event.preventDefault(); event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDragOver('tab:' + t.id);
            // Hovering over a tab during a drag switches to it, like browser tabs do.
            if (tabHover.current?.id !== t.id && t.id !== tab.id) {
              clearTimeout(tabHover.current?.timer);
              tabHover.current = { id: t.id, timer: window.setTimeout(() => { tabHover.current = null; setActiveID(t.id); resetNavigation(); }, 600) };
            }
          }}
          onDragLeave={event => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            if (tabHover.current?.id === t.id) { clearTimeout(tabHover.current.timer); tabHover.current = null; }
            setDragOver(null);
          }}
          onDrop={event => { if (tabHover.current?.id === t.id) { clearTimeout(tabHover.current.timer); tabHover.current = null; } drop(event, t.location); }}>
          <button role="tab" aria-selected={t.id === tab.id} className="tab-label" onPointerDown={event => startTabDrag(event, t.id)} onPointerMove={moveTabDrag} onPointerUp={event => { tabDrag.current = null; event.currentTarget.style.transform = ''; }} onPointerCancel={event => { tabDrag.current = null; event.currentTarget.style.transform = ''; }} onKeyDown={event => { if (event.key === 'Escape') { tabDrag.current = null; event.currentTarget.style.transform = ''; } }} onClick={() => { if (suppressTabClick.current) { suppressTabClick.current = false; return; } setActiveID(t.id); resetNavigation(); }} onAuxClick={event => { if (event.button === 1) closeTab(t.id); }}>
            {isVirtual(t.location) ? <PlaceIcon icon={isTrashLocation(t.location) ? 'trash' : t.location} size={16}/> : <FolderGlyph dimension={21} badge={folderIcon(t.location)}/>}<span>{label(t.location)}</span>
          </button>
          <button className="tab-close" aria-label={tr('关闭 {0} 标签页', label(t.location))} title={shortcutLabel('关闭标签页', 'close-tab')} onClick={() => closeTab(t.id)}><X size={13}/></button>
        </div>)}
      </div>
      <ToolButton label={shortcutLabel('新建标签页', 'new-tab')} className="new-tab" onClick={() => newTab()}><Plus size={17}/></ToolButton>
    </header>

    <div className="navigation-bar">
      <div className="history-controls">
        <ToolButton label={shortcutLabel('后退', 'back')} disabled={tab.index === 0} onClick={() => historyGo(-1)}><ArrowLeft/></ToolButton>
        <ToolButton label={shortcutLabel('前进', 'forward')} disabled={tab.index >= tab.history.length - 1} onClick={() => historyGo(1)}><ArrowRight/></ToolButton>
        <ToolButton label={shortcutLabel('向上一级', 'parent')} disabled={location === TRASH || !viewingTrash && (isVirtual(location) || location === '/')} onClick={goParent}><ArrowUp/></ToolButton>
        <ToolButton label={shortcutLabel('刷新', 'refresh')} onClick={refreshDirectory}><RotateCw className={loading ? 'spinning' : ''}/></ToolButton>
      </div>
      <div className={`address-bar ${editingAddress ? 'editing' : ''}`} onClick={editAddress}>
        <span className="address-icon"><PlaceIcon icon={viewingTrash ? 'trash' : isVirtual(location) ? location : folderIcon(location) || 'folder'} size={17}/></span>
        {editingAddress ? <form onSubmit={event => { event.preventDefault(); goAddress(); }}><input ref={addressRef} aria-label={tr('文件夹地址')} aria-controls={addressSuggestions.length ? 'address-suggestions' : undefined} aria-activedescendant={addressActive >= 0 && addressSuggestions.length ? `address-suggestion-${addressActive}` : undefined} autoComplete="off" value={address} onChange={event => { setAddress(event.target.value); setAddressQuery(event.target.value); setAddressActive(-1); }} onBlur={() => setEditingAddress(false)} onKeyDown={addressKeyDown}/></form> : <div className="breadcrumbs" onContextMenu={event => { if (!isVirtual(location)) addressMenu(event, location); }}>
          {isVirtual(location) ? <button onClick={editAddress}>{label(location)}</button> : <>
            <button className="crumb-chevron" aria-label={tr('{0} 的子文件夹', tr('此电脑'))} onClick={event => crumbMenu(event, null)}><ChevronRight size={13}/></button>
            {breadcrumbs.map(crumb => <span key={crumb.path}>
              <button title={crumb.path === location ? tr('单击编辑路径') : crumb.path} onContextMenu={event => addressMenu(event, crumb.path)} onClick={event => { if (crumb.path !== location) { event.stopPropagation(); navigate(crumb.path); } }}>{crumb.name}</button>
              <button className="crumb-chevron" aria-label={tr('{0} 的子文件夹', crumb.name)} onClick={event => crumbMenu(event, crumb.path)}><ChevronRight size={13}/></button>
            </span>)}
          </>}
        </div>}
        {addressSuggestions.length > 0 && <ul id="address-suggestions" className="address-suggestions" role="listbox" aria-label={addressQuery === null ? tr('最近输入的地址') : tr('匹配的文件夹')} onMouseDown={event => event.preventDefault()}>
          {addressSuggestions.map((value, index) => <li key={value} id={`address-suggestion-${index}`} role="option" aria-selected={index === addressActive} title={value} onClick={() => void goAddress(value)}>{value}</li>)}
        </ul>}
      </div>
      <form className="search-box" onSubmit={event => { event.preventDefault(); setSubmittedQuery(query.trim()); setSelected(new Set()); }}>
        <input ref={searchRef} disabled={location === AIRDROP} aria-label={tr('搜索文件')} placeholder={tr('在{0}中搜索', label(location))} value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setSubmittedQuery(''); }}/>
        {query ? <button type="button" title={tr('清除搜索')} aria-label={tr('清除搜索')} onClick={() => { setQuery(''); setSubmittedQuery(''); }}><X size={15}/></button> : <Search size={17}/>}<button className="sr-only" type="submit">{tr('搜索')}</button>
      </form>
    </div>

    <div className="command-bar">
      <ToolButton label={tr('新建')} disabled={!writable || !!operation} className="text-tool" onClick={event => buttonMenu(event, newMenu)}><Plus className="new-icon"/><span>{tr('新建')}</span><ChevronDown size={12}/></ToolButton>
      {toolbar.length > 0 && <><span className="toolbar-separator"/><div className="command-tools" role="group" aria-label={tr('常用操作')}>{toolbar.map(id => {
        const tool = toolbarTools[id];
        return <ToolButton key={id} label={tool.label} disabled={tool.disabled} onClick={tool.action}>{tool.icon}</ToolButton>;
      })}</div><span className="toolbar-separator"/></>}
      <ToolButton label={tr('排序')} className="text-tool" onClick={event => buttonMenu(event, sortMenu)}><ArrowDownWideNarrow/><span>{tr('排序')}</span><ChevronDown size={12}/></ToolButton>
      <ToolButton label={tr('查看')} className="text-tool" onClick={event => buttonMenu(event, viewMenu)}><List/><span>{tr('查看')}</span><ChevronDown size={12}/></ToolButton>
      <ToolButton label={tr('更多')} onClick={event => buttonMenu(event, [
        { label: tr('打开文件夹…'), icon: <FolderOpen/>, action: chooseFolder },
        { label: pinTarget && places.some(place => place.path === pinTarget) ? tr('从快速访问取消固定') : tr('固定到快速访问'), icon: <Pin/>, disabled: !pinTarget, action: () => pinTarget && togglePin(pinTarget) },
        { label: tr('全选'), shortcut: shortcutHint('select-all'), action: () => setSelected(new Set(visible.map(e => e.path))) },
        { label: tr('取消选择'), action: () => setSelected(new Set()) },
        { label: undoLabel ? tr('撤销{0}', undoLabel) : tr('撤销'), icon: <Undo2/>, shortcut: shortcutHint('undo'), disabled: !undoLabel, divider: true, action: undo },
        { label: tr('设置…'), icon: <AppWindow/>, divider: true, action: () => showModal({ kind: 'settings' }) },
      ])}><MoreHorizontal/></ToolButton>
      <div className="command-spacer"/>
      <ToolButton label={tr('预览窗格')} className="text-tool details-toggle" active={previewPane} onClick={togglePreview}><PanelRight/><span>{tr('预览')}</span></ToolButton>
    </div>

    <div className="workspace">
      {navigationPane && <nav className="sidebar" aria-label={tr('文件位置')}>
        <div className="sidebar-top">
          <button className={`nav-item ${location === boot?.home ? 'current' : ''}`} onClick={() => boot && navigate(boot.home)}><PlaceIcon icon="folder"/><span>{tr('个人文件夹')}</span></button>
        </div>
        <div className="nav-divider"/>
        <div className="sidebar-section" aria-label={tr('快速访问')} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPlaceMarker(null); }}>
          {places.map(place => <NavigationTree key={place.path} place={{ ...place, name: label(place.path) }} folderIcon={folderIcon} location={location} hidden={hidden} pinned navigate={navigate} newTab={newTab} drop={drop} reorder={{ over: event => placeDragOver(event, place.path), drop: event => dropPlace(event, place.path) }}
            context={(event, target) => menuAt(event, [{ label: tr('在新标签页中打开'), icon: <Plus/>, action: () => newTab(target.path) }, terminalItem(target.path), { label: places.some(place => place.path === target.path) ? tr('从快速访问取消固定') : tr('固定到快速访问'), icon: <Pin/>, action: () => togglePin(target.path) }])}/>)}
          {placeMarker && <div className="place-drop-line" style={{ top: placeMarker.top }}/>}
        </div>
        <div className="nav-divider"/>
        <button className={`nav-item parent-nav ${location === PC ? 'current' : ''}`} onClick={() => navigate(PC)}><ChevronDown className="nav-chevron" size={12}/><PlaceIcon icon="computer"/><span>{tr('此电脑')}</span></button>
        {boot?.volumes.map(volume => <NavigationTree key={volume.path} place={volume} folderIcon={folderIcon} location={location} hidden={hidden} navigate={navigate} newTab={newTab} drop={drop} level={1} eject={volume.canEject ? () => ejectVolume(volume) : undefined} ejecting={!!operation} context={(event, target) => menuAt(event, [{ label: tr('在新标签页中打开'), icon: <Plus/>, action: () => newTab(target.path) }, terminalItem(target.path), ...(volume.canEject && target.path === volume.path ? [{ label: tr('推出“{0}”', volume.name), icon: <Eject/>, disabled: !!operation, action: () => ejectVolume(volume) }] : [])])}/>)}
        <button className={`nav-item ${viewingTrash ? 'current' : ''}`} onClick={() => navigate(TRASH)} onAuxClick={event => { if (event.button === 1) newTab(TRASH); }} onContextMenu={event => menuAt(event, [{ label: tr('在新标签页中打开'), icon: <Plus/>, action: () => newTab(TRASH) }])}><PlaceIcon icon="trash"/><span>{tr('回收站')}</span></button>
        {[AIRDROP, NETWORK].map(destination => <button key={destination} className={`nav-item ${location === destination ? 'current' : ''}`} onClick={() => navigate(destination)} onAuxClick={event => { if (event.button === 1) newTab(destination); }} onContextMenu={event => menuAt(event, [{ label: tr('在新标签页中打开'), icon: <Plus/>, action: () => newTab(destination) }])}
          onDragOver={event => { if (destination === AIRDROP && !isPlaceDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => drop(event, destination)}><PlaceIcon icon={destination}/><span>{label(destination)}</span></button>)}
      </nav>}

      <main className={`main-pane ${details || previewPane ? 'has-details' : ''}`}>
        {viewingTrash && trashOperationError && !error && <div className="error-bar" role="alert"><Info size={17}/><span>{trashOperationError}</span><button aria-label={tr('关闭操作错误提示')} onClick={() => setTrashOperationError('')}><X size={15}/></button></div>}
        {error && <div className="error-bar" role="alert"><Info size={17}/><span>{error}</span>{error.includes(tr('完全磁盘访问权限')) && <button className="permission-settings-button" disabled={openingPrivacySettings} onClick={() => void openPrivacySettings()} title={tr('打开系统设置中的完全磁盘访问权限')}>{openingPrivacySettings ? tr('正在打开…') : tr('前往设置')}</button>}<button title={tr('关闭提示')} aria-label={tr('关闭错误提示')} onClick={() => setError('')}><X size={15}/></button></div>}
        {vcsStatus && <div className="vcs-summary" role="status"><span>{vcsStatus.kind === 'git' ? 'Git' : 'SVN'}{vcsStatus.branch ? ` · ${vcsStatus.branch}` : ''}</span>{vcsStatus.error ? <span className="vcs-error">{vcsStatus.error}</span> : <span>{tr('本地版本状态')}</span>}<button className="secondary-button" onClick={() => setRefresh(value => value + 1)}>{tr('刷新版本状态')}</button></div>}
        {viewingTrash && <div className="search-summary"><Trash2 size={16}/><span>{tr('回收站')}</span><small>{tr('还原到原位置；无法确定原位置时选择文件夹')}</small><button className="secondary-button" disabled={!selected.size || !!operation} onClick={() => restoreTrash()}>{tr('还原')}</button><button className="secondary-button" disabled={!!operation} onClick={clearTrash}>{tr('清空回收站…')}</button></div>}
        {submittedQuery && !connectionPage && <div className="search-summary"><Search size={16}/><span>{tr('“{0}” 的搜索结果', submittedQuery)}</span><small>{loading ? tr('正在搜索子文件夹…') : searchNote || tr('{0} 个匹配项目', visible.length)}</small><button onClick={() => { setQuery(''); setSubmittedQuery(''); }}>{tr('退出搜索')}</button></div>}
        <div ref={contentRef} tabIndex={0} className={`file-content view-${view} ${dragOver === location ? 'drop-target' : ''}`} aria-label={label(location)} aria-busy={loading}
          onPointerDown={startMarquee} onClickCapture={event => { if (suppressMarqueeClick.current) { event.preventDefault(); event.stopPropagation(); suppressMarqueeClick.current = false; } }}
          onContextMenu={event => contextMenu(event)}
          onDragOver={event => { if ((writable || location === AIRDROP) && !isPlaceDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = location === AIRDROP ? 'copy' : 'move'; setDragOver(location); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(null); }} onDrop={event => drop(event, location)}>
          {location === AIRDROP ? <AirDropPage busy={!!operation} choose={() => sendAirDrop()}/> : location === NETWORK ? <NetworkPage volumes={boot?.volumes || []} refresh={refresh} query={submittedQuery} busy={!!operation} connect={connectNetwork} open={navigate} rescan={refreshDirectory}/> : location === PC && !submittedQuery ? <div className="computer-content"><h2><ChevronDown size={14}/>{tr('设备和驱动器（{0}）', boot?.volumes.length || 0)}</h2><div className="drive-grid">{boot?.volumes.map(volume => <button className="drive-card" key={volume.path} onContextMenu={event => menuAt(event, [{ label: tr('打开'), action: () => navigate(volume.path) }, ...(volume.canEject ? [{ label: tr('推出“{0}”', volume.name), icon: <Eject/>, disabled: !!operation, action: () => ejectVolume(volume) }] : [])])} onDoubleClick={() => navigate(volume.path)} onKeyDown={event => { if (event.key === 'Enter') navigate(volume.path); }}><DriveGlyph path={volume.path}/><span className="drive-info"><strong title={volume.name}>{volume.name}</strong><span className="drive-kind">{tr('本地磁盘')}</span><span className="storage-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, (1 - volume.free / volume.total) * 100))}%` }}/></span><span className="drive-capacity"><span>{tr('{0} 可用', size(volume.free))}</span><span>{tr('共 {0}', size(volume.total))}</span></span></span></button>)}</div></div> : loading ? <Loading/> : visible.length ? fileRows() : <div className="empty-state">{submittedQuery ? <Search size={42} strokeWidth={1.2}/> : <FolderGlyph dimension={68}/>}<h2>{error ? tr('无法显示此位置') : submittedQuery ? tr('没有找到匹配的项目') : viewingTrash ? tr('回收站为空') : tr('此文件夹为空')}</h2><p>{error ? tr('检查访问权限，或返回上一个文件夹。') : submittedQuery ? tr('尝试其他名称，或到上一级文件夹中搜索。') : viewingTrash ? tr('这里显示回收站中的项目。') : tr('将文件拖到这里，或使用“新建”创建文件夹。')}</p>{error && <button className="secondary-button" onClick={() => setRefresh(v => v + 1)}>{tr('重试')}</button>}</div>}
          {selectionBox && <div className="selection-marquee" style={selectionBox} aria-hidden="true"/>}
        </div>
      </main>
      {details && <aside className="details-pane" aria-label={tr('详细信息')}><div className="details-header"><h2>{tr('详细信息')}</h2><button aria-label={tr('关闭详细信息')} onClick={() => setDetails(false)}><X size={17}/></button></div>
        {single ? <><div className="preview-hero">{preview?.kind === 'image' ? <img src={preview.content} alt={single.name}/> : <FileGlyph entry={single} dimension={70} badge={folderIcon(single.path)}/>}</div><h3>{single.name}</h3><p className="detail-kind">{type(single)}</p><dl><dt>{tr('位置')}</dt><dd title={parent(single.path)}>{parent(single.path)}</dd><dt>{tr('大小')}</dt><dd>{single.isDirectory ? tr('文件夹') : tr('{0}（{1} 字节）', size(single.size), single.size.toLocaleString(getLocale()))}</dd><dt>{tr('修改日期')}</dt><dd>{date(single.modified)}</dd><dt>{tr('创建日期')}</dt><dd>{date(single.created)}</dd>{single.isSymlink && <><dt>{tr('链接')}</dt><dd>{tr('符号链接')}</dd></>}</dl>{preview?.kind === 'text' && <div className="text-preview"><h4>{tr('内容预览')}</h4><pre>{preview.content}</pre>{preview.truncated && <small>{tr('仅显示前 16 KB')}</small>}</div>}<button className="secondary-button" onClick={() => run(tr('正在预览…'), () => api.quickLook(single.path))}>{tr('快速查看')}<span>Space</span></button></> : <div className="details-empty">{chosen.length > 1 ? <Copy size={46} strokeWidth={1.1}/> : <FolderGlyph dimension={75}/>}<h3>{chosen.length > 1 ? tr('已选择 {0} 个项目', chosen.length) : label(location)}</h3><p>{chosen.length > 1 ? tr('文件大小合计 {0}', size(totalSelected)) : tr('选择一个文件，查看预览和详细信息。')}</p></div>}
      </aside>}
      {previewPane && <aside className="details-pane preview-pane" aria-label={tr('预览窗格')}><div className="details-header"><h2>{tr('预览')}</h2><button aria-label={tr('关闭预览')} onClick={() => setPreviewPane(false)}><X size={17}/></button></div>
        {!single ? <div className="details-empty"><PanelRight size={46} strokeWidth={1.1}/><p>{chosen.length > 1 ? tr('请选择一个文件进行预览。') : tr('选择要预览的文件。')}</p></div> : <><h3>{single.name}</h3>{preview?.kind === 'image' ? <img className="pane-image-preview" src={preview.content} alt={single.name}/> : preview?.kind === 'text' ? <div className="text-preview"><pre>{preview.content}</pre>{preview.truncated && <small>{tr('仅显示前 16 KB')}</small>}</div> : <div className="details-empty"><FileGlyph entry={single} dimension={70} badge={folderIcon(single.path)}/><p>{preview ? single.isDirectory ? tr('文件夹不提供内容预览。') : tr('此文件无法在窗格中预览。') : tr('正在加载预览…')}</p>{!single.isDirectory && <button className="secondary-button" onClick={() => run(tr('正在预览…'), () => api.quickLook(single.path))}>{tr('快速查看')}</button>}</div>}</>}
      </aside>}
    </div>

    <footer className="status-bar"><span>{connectionPage ? label(location) : loading ? tr('正在读取…') : location === PC && !submittedQuery ? tr('{0} 个驱动器', boot?.volumes.length || 0) : tr('{0} 个项目', visible.length)}</span>{selected.size > 0 && <><span className="status-divider"/><span>{tr('已选择 {0} 个项目', selected.size)}</span>{totalSelected > 0 && <span>{size(totalSelected)}</span>}</>}<span className="status-feedback" role="status">{operation ? <><Loader2 size={12} className="spinning"/>{operation}</> : toast ? <><Check size={13}/>{toast}</> : hidden ? tr('显示隐藏的项目') : ''}</span>{!connectionPage && view === 'icons' && <label className="icon-size-control"><span>{tr('图标大小')}</span><input type="range" aria-label={tr('图标大小')} min={32} max={128} step={8} value={iconSize} onChange={event => changeView({ iconSize: Number(event.target.value) })}/><output>{iconSize}</output></label>}<button className={view === 'details' ? 'current' : ''} title={tr('详细信息视图')} aria-label={tr('详细信息视图')} aria-pressed={view === 'details'} onClick={() => changeView({ view: 'details' })}><List size={16}/></button><button className={view === 'icons' ? 'current' : ''} title={tr('大图标视图')} aria-label={tr('大图标视图')} aria-pressed={view === 'icons'} onClick={() => changeView({ view: 'icons' })}><LayoutGrid size={15}/></button></footer>

    {popup && <ContextMenu popup={popup} onClose={() => setPopup(null)}/>}
    {modal?.kind === 'archive' && <ArchiveDialog archive={modal.archive} onExtracted={() => setRefresh(v => v + 1)} onClose={() => setModal(null)}/>}
    {modal?.kind === 'settings' && <SettingsDialog theme={theme} language={language} onThemeChange={async mode => setTheme(await api.setTheme(mode))} onLanguageChange={changeLanguage} toolbar={toolbar} onToolbarChange={setToolbar} tools={toolbarTools} onClose={() => setModal(null)}/>}
    {modal?.kind === 'vcs' && <VcsDialog directory={modal.directory} paths={modal.paths} action={modal.action} enabled={!!vcsEnabled} onChanged={() => setRefresh(value => value + 1)} onClose={() => setModal(null)}/>}
    {modal && modal.kind !== 'archive' && modal.kind !== 'settings' && modal.kind !== 'vcs' && <ModalDialog modal={modal} value={modalValue} onChange={setModalValue} error={modalError} busy={!!operation} onClose={() => { if (!operation) setModal(null); }} onSubmit={submitModal}/>}
  </div>;
}

function ArchiveDialog({ archive, onClose, onExtracted }: { archive: ArchivePreview; onClose: () => void; onExtracted: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  const [folder, setFolder] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<ExtractMode>('choose');
  const [modeMenu, setModeMenu] = useState<Popup | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState(false);
  const modes = [{ value: 'choose', label: tr('指定路径') }, { value: 'here', label: tr('当前路径') }, { value: 'folder', label: archiveFolderName(archive.name) }] as const;
  function closeModeMenu() { setModeMenu(null); modeButton.current?.focus(); }
  function openModeMenu() {
    ref.current?.getAnimations().forEach(animation => animation.finish());
    const anchor = modeButton.current!.getBoundingClientRect();
    setModeMenu({ x: anchor.left, y: anchor.bottom + 4, items: modes.map(option => ({ label: option.label, radio: true, checked: mode === option.value, action: () => setMode(option.value) })) });
  }
  const items = useMemo(() => {
    const result = new Map<string, boolean>();
    for (const entry of archive.entries) {
      if (!entry.path.startsWith(folder)) continue;
      const relative = entry.path.slice(folder.length);
      const slash = relative.indexOf('/');
      const name = slash < 0 ? relative : relative.slice(0, slash);
      if (name) result.set(name, !!result.get(name) || slash >= 0 || entry.directory);
    }
    return [...result].sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0], getLocale(), { numeric: true }));
  }, [archive, folder]);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => api.onAction(action => { if (action === 'select-all' && !lock.current) setSelected(new Set(items.map(([name]) => name))); }), [items]);
  function enter(destination: string) { setFolder(destination); setSelected(new Set()); }
  function toggle(name: string) { setSelected(previous => { const next = new Set(previous); if (next.has(name)) next.delete(name); else next.add(name); return next; }); }
  function close() { if (!lock.current) onClose(); }
  async function openMember(name: string, directory: boolean) {
    if (lock.current) return;
    if (directory) { enter(folder + name + '/'); return; }
    lock.current = true; setBusy(true); setMessage(tr('正在打开文件…')); setFailure(false);
    try {
      await api.openArchiveFile(archive.path, folder + name);
      setMessage(tr('已用默认应用打开临时副本。修改不会写回压缩包；需要保留修改请另存到指定位置。'));
    } catch (e) { setFailure(true); setMessage(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function extract(all: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage(''); setFailure(false);
    try {
      const result = await api.extractArchive(archive.path, all ? null : [...selected].map(name => folder + name), mode);
      if (result) {
        setFailure(!!result.errors.length);
        setMessage(`${result.succeeded.length ? tr('已解压到：{0}{1}', result.succeeded.slice(0, 2).join('、'), result.succeeded.length > 2 ? tr(' 等位置') : '') : tr('未解压任何项目。')}${result.errors.length ? '\n' + result.errors.slice(0, 3).map(e => `${base(e.path)}：${e.message}`).join('\n') : ''}`);
        onExtracted();
      }
    } catch (e) { setFailure(true); setMessage(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <dialog ref={ref} className="modal archive-dialog" aria-labelledby="archive-title" onPointerDown={() => setModeMenu(null)} onCancel={event => { event.preventDefault(); close(); }} onClose={close} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); if (!busy) setSelected(new Set(items.map(([name]) => name))); }
  }}>
    <div className="archive-heading"><div className="modal-heading"><h2 id="archive-title">{archive.name}</h2><button disabled={busy} aria-label={tr('关闭压缩包预览')} onClick={close}><X size={18}/></button></div>
      <div className="archive-navigation"><ToolButton label={tr('压缩包内向上一级')} disabled={!folder || busy} onClick={() => enter(folder.slice(0, -1).slice(0, folder.slice(0, -1).lastIndexOf('/') + 1))}><ArrowUp/></ToolButton><span title={folder}>{folder || tr('压缩包根目录')}</span></div>
      <div className="archive-actions"><label>{tr('解压位置')}<button ref={modeButton} className="secondary-button archive-destination" aria-label={tr('解压位置')} aria-describedby="archive-destination-value" aria-haspopup="menu" aria-expanded={!!modeMenu} title={modes.find(option => option.value === mode)!.label} disabled={busy} onPointerDown={event => event.stopPropagation()} onClick={() => modeMenu ? closeModeMenu() : openModeMenu()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openModeMenu(); }
      }}><span id="archive-destination-value">{modes.find(option => option.value === mode)!.label}</span><ChevronDown size={14}/></button></label>
        <button className="secondary-button" disabled={busy || !selected.size} onClick={() => extract(false)}>{tr('解压选中项')}</button><button className="primary-button" disabled={busy || !archive.entries.length} onClick={() => extract(true)}>{tr('全部解压')}</button>
      </div>
    </div>
    <div className="archive-selection"><label><input type="checkbox" aria-label={tr('全选当前目录')} disabled={busy || !items.length} checked={!!items.length && selected.size === items.length} onChange={event => setSelected(new Set(event.target.checked ? items.map(([name]) => name) : []))}/>{tr('全选当前目录')}</label><span>{tr('保留包内目录结构 · 已选 {0} 项', selected.size)}</span></div>
    <div className="archive-list" role="list" aria-label={tr('压缩包内容')} aria-busy={busy}>{items.length ? items.map(([name, directory]) => <div key={name} className={`archive-entry ${selected.has(name) ? 'selected' : ''}`}>
      <input type="checkbox" aria-label={tr('选择 {0}', name)} checked={selected.has(name)} disabled={busy} onChange={() => toggle(name)}/>
      <button disabled={busy} aria-label={`${name}${directory ? tr(' 文件夹') : ''}`} onClick={event => { if (event.ctrlKey || event.metaKey) toggle(name); else setSelected(new Set([name])); }} onDoubleClick={() => openMember(name, directory)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openMember(name, directory); } }}>
        {directory ? <FolderGlyph dimension={24}/> : <FileText size={22} strokeWidth={1.2}/>}<span>{name}</span><small>{directory ? tr('文件夹') : tr('文件')}</small>
      </button>
    </div>) : <p className="archive-empty">{tr('此压缩包为空')}</p>}</div>
    {message && <div className={`archive-result ${failure ? 'failed' : ''}`} role={failure ? 'alert' : 'status'}>{message}</div>}
    {modeMenu && <ContextMenu popup={modeMenu} label={tr('解压位置')} onClose={closeModeMenu}/>}
    <div className="archive-footer"><span>{busy ? tr('正在处理压缩包，请稍候…') : tr('{0} 个项目 · 同名项目会跳过，不覆盖', items.length)}</span><button className="secondary-button" disabled={busy} onClick={close}>{tr('关闭')}</button></div>
  </dialog>;
}

function SettingsHelp({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const popupRef = useRef<HTMLDivElement>(null);
  function showHelp(anchor: HTMLSpanElement) {
    const popup = popupRef.current;
    if (!popup) return;
    popup.showPopover();
    const target = anchor.querySelector('button')!.getBoundingClientRect(); const bubble = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(12, Math.min(target.left, innerWidth - bubble.width - 12))}px`;
    popup.style.top = `${Math.max(12, target.bottom + bubble.height + 8 <= innerHeight - 12 ? target.bottom + 8 : target.top - bubble.height - 8)}px`;
  }
  return <span className="settings-help" onMouseEnter={event => showHelp(event.currentTarget)} onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) popupRef.current?.hidePopover(); }} onFocus={event => showHelp(event.currentTarget)} onBlur={event => { if (!event.currentTarget.matches(':hover')) popupRef.current?.hidePopover(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popupRef.current?.hidePopover(); } }}>
    <button type="button" className="settings-help-button" aria-label={label} aria-describedby={id} onClick={event => showHelp(event.currentTarget.parentElement!)}><CircleHelp size={16} aria-hidden="true"/></button>
    <div ref={popupRef} id={id} className="settings-help-bubble settings-note" role="tooltip" popover="auto">{children}</div>
  </span>;
}

function SettingsDialog({ onClose, toolbar, onToolbarChange, tools, theme, language, onThemeChange, onLanguageChange }: {
  onClose: () => void; toolbar: ToolbarAction[]; onToolbarChange: (value: ToolbarAction[]) => void; tools: Record<ToolbarAction, ToolbarTool>;
  theme: ThemeMode; language: LanguageState; onThemeChange: (mode: ThemeMode) => Promise<void>; onLanguageChange: (mode: LanguageMode) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const hideHelp = () => ref.current?.querySelector<HTMLDivElement>('.settings-help-bubble:popover-open')?.hidePopover();
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  function moveDialog(left: number, top: number) {
    const dialog = ref.current;
    if (!dialog) return;
    const bounds = dialog.getBoundingClientRect();
    Object.assign(dialog.style, {
      margin: '0', right: 'auto', bottom: 'auto',
      left: `${Math.max(12, Math.min(left, innerWidth - bounds.width - 12))}px`,
      top: `${Math.max(12, Math.min(top, innerHeight - bounds.height - 12))}px`,
    });
  }
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('button')) return;
    event.preventDefault();
    hideHelp();
    ref.current?.getAnimations().forEach(animation => animation.finish());
    const bounds = ref.current!.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  useEffect(() => {
    const resize = () => {
      drag.current = null; hideHelp();
      const dialog = ref.current;
      if (dialog?.style.left) moveDialog(parseFloat(dialog.style.left), parseFloat(dialog.style.top));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const id = useId();
  const [section, setSection] = useState('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [fileViewer, setFileViewer] = useState<FileViewerSettings | null>(null);
  const [fileViewerError, setFileViewerError] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [operationDraft, setOperationDraft] = useState<OperationShortcuts>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [foldersReset, setFoldersReset] = useState(false);
  const tabs = [{ id: 'general', label: tr('常规') }, { id: 'toolbar', label: tr('自定义工具栏') }, { id: 'shortcuts', label: tr('键盘快捷键') }, { id: 'about', label: tr('关于') }];
  useEffect(() => {
    let live = true;
    const refresh = () => void api.fileViewerSettings().then(value => { if (live) { setFileViewer(value); setFileViewerError(''); } }).catch(error => { if (live) setFileViewerError(errorMessage(error)); });
    refresh();
    const stop = api.onSettingsChanged(refresh);
    return () => { live = false; stop(); };
  }, []);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    let live = true;
    let previous: AppSettings | null = null;
    const receive = (value: AppSettings) => {
      if (!live) return;
      const before = previous; previous = value;
      setSettings(value);
      setShortcut(current => !before || current === before.wakeShortcut ? value.wakeShortcut : current);
      setOperationDraft(current => !before || JSON.stringify(current) === JSON.stringify(before.operationShortcuts) ? value.operationShortcuts : current);
      setError(value.wakeShortcutError);
    };
    void api.settings().then(receive).catch(error => { if (live) setError(errorMessage(error)); });
    const stop = api.onSettingsChanged(receive);
    return () => { live = false; stop(); };
  }, []);
  async function save(action: () => Promise<AppSettings | void>) {
    setBusy(true); setError('');
    try { const value = await action(); if (value) setSettings(value); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  let wakeConflict = ''; let operationConflict = '';
  try { validateWakeBinding(shortcut, settings?.operationShortcuts ?? {}); } catch (error) { wakeConflict = errorMessage(error); }
  try { validateOperationShortcuts(operationDraft, settings?.wakeShortcut || ''); } catch (error) { operationConflict = errorMessage(error); }
  const operationsChanged = JSON.stringify(operationDraft) !== JSON.stringify(settings?.operationShortcuts ?? {});
  const display = shortcut.replace('Command', '⌘').replace('Control', '⌃').replace('Alt', '⌥').replace('Shift', '⇧');
  return <dialog ref={ref} className="modal settings-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-heading settings-drag-handle" role="group" tabIndex={0} aria-label={tr('拖动或使用方向键移动设置窗口')} title={tr('拖动或使用方向键移动设置窗口')} onPointerDown={startDrag} onPointerMove={event => {
      const current = drag.current;
      if (current?.pointerId === event.pointerId) moveDialog(current.left + event.clientX - current.x, current.top + event.clientY - current.y);
    }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      const delta = ({ ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] } as Record<string, number[]>)[event.key];
      if (!delta) return;
      event.preventDefault(); hideHelp();
      ref.current?.getAnimations().forEach(animation => animation.finish());
      const bounds = ref.current!.getBoundingClientRect(); moveDialog(bounds.left + delta[0], bounds.top + delta[1]);
    }}><div className="settings-title"><AppWindow size={18}/><h2 id={`${id}-title`}>{tr('设置')}</h2></div><button aria-label={tr('关闭设置')} disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <div className="settings-tabs" role="tablist" aria-label={tr('设置分类')}>
      {tabs.map((tab, index) => <button key={tab.id} id={`${id}-tab-${tab.id}`} role="tab" aria-selected={section === tab.id} aria-controls={`${id}-panel-${tab.id}`} tabIndex={section === tab.id ? 0 : -1} disabled={busy} onClick={() => setSection(tab.id)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        setSection(tabs[next].id);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
      }}>{tab.label}</button>)}
    </div>
    <div className="settings-panel" id={`${id}-panel-general`} role="tabpanel" aria-labelledby={`${id}-tab-general`} hidden={section !== 'general'} tabIndex={0} onScroll={() => hideHelp()}>
      <fieldset className="settings-group"><legend>{tr('外观')}</legend><div className="theme-options">
        {([{ mode: 'light', label: tr('浅色'), icon: <Sun size={17}/> }, { mode: 'dark', label: tr('深色'), icon: <Moon size={17}/> }, { mode: 'system', label: tr('跟随系统'), icon: <Monitor size={17}/> }] as const).map(option => <label key={option.mode}><input type="radio" name={`${id}-theme`} checked={theme === option.mode} disabled={busy} onChange={() => void save(() => onThemeChange(option.mode))}/>{option.icon}<span>{option.label}</span></label>)}
      </div></fieldset>
      <fieldset className="settings-group"><legend>{tr('语言')}</legend><label className="settings-language"><span>{tr('界面语言')}</span><select aria-label={tr('界面语言')} value={language.mode} disabled={busy} onChange={event => void save(() => onLanguageChange(event.target.value as LanguageMode))}>
        <option value="system">{tr('跟随系统')}</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option>
      </select></label></fieldset>
      <fieldset className="settings-group"><legend>{tr('系统文件查看器（实验）')}</legend>
        <div className="settings-toggle-row"><label className="settings-toggle"><input type="checkbox" role="switch" aria-describedby={`${id}-file-viewer-note`} checked={fileViewer?.enabled ?? false} disabled={busy || !fileViewer?.available || fileViewer.enabled && !fileViewer.canRestore} onChange={event => {
          const enabled = event.target.checked; const previous = fileViewer;
          setFileViewer(current => current ? { ...current, enabled } : current);
          void save(async () => { try { setFileViewer(await api.setFileViewer(enabled)); } catch (error) { setFileViewer(previous); throw error; } });
        }}/><span>{tr('使用 Mac Explorer 显示文件')}</span></label>
          <SettingsHelp id={`${id}-file-viewer-note`} label={tr('文件查看器说明')}>
            <p>{tr('让支持系统文件查看器的软件将“在访达中显示”等请求交给 Mac Explorer。关闭后恢复启用前的设置。')}</p>
            <p>{tr('部分软件仍会调用 Finder，菜单名称也可能保持不变。普通文件夹的打开方式可能需要重新登录或重启后生效。')}</p>
            <p>{tr('不会替换桌面及系统“打开／保存”窗口。')}</p>
          </SettingsHelp>
        </div>
        {fileViewer && !fileViewer.available && <p className="settings-note">{tr('请在打包后的 Mac Explorer 中设置文件查看器。')}</p>}
        {(fileViewerError || fileViewer?.error) && <p className="modal-error" role="alert">{fileViewerError || fileViewer?.error}</p>}
      </fieldset>
      <fieldset className="settings-group"><legend>{tr('版本控制')}</legend><div className="settings-toggle-row"><label className="settings-toggle"><input type="checkbox" aria-describedby={`${id}-vcs-note`} checked={settings?.versionControl ?? true} disabled={!settings || busy} onChange={event => {
        const enabled = event.target.checked; const previous = settings;
        setSettings(current => current ? { ...current, versionControl: enabled } : current);
        void save(async () => { try { return await api.setVersionControl(enabled); } catch (error) { setSettings(previous); throw error; } });
      }}/><span>{tr('启用 Git / SVN 状态角标和右键菜单')}</span></label>
        <SettingsHelp id={`${id}-vcs-note`} label={tr('版本控制说明')}><p>{tr('仅在仓库内启用。关闭后停止状态检测与刷新；需要已安装 Git 或 SVN 命令行工具。')}</p></SettingsHelp>
      </div></fieldset>
      <fieldset className="settings-group"><legend>{tr('文件夹视图')}</legend>{(() => {
        const defaults = settings?.folderViewDefaults ?? defaultFolderView;
        const change = (changes: Partial<FolderView>) => {
          const previous = settings; const next = { ...defaults, ...changes };
          setSettings(current => current ? { ...current, folderViewDefaults: next } : current); setFoldersReset(false);
          void save(async () => { try { return await api.setFolderViewDefaults(next); } catch (error) { setSettings(previous); throw error; } });
        };
        const layouts = [{ value: 'icons:128', label: tr('超大图标') }, { value: 'icons:64', label: tr('大图标') }, { value: 'icons:48', label: tr('中图标') }, { value: 'icons:32', label: tr('小图标') },
          { value: 'list', label: tr('列表') }, { value: 'details', label: tr('详细信息') }, { value: 'tiles', label: tr('平铺') }, { value: 'content', label: tr('内容') }];
        const layout = defaults.view === 'icons' ? `icons:${defaults.iconSize}` : defaults.view;
        // Ctrl+scroll sizes and "Apply to all folders" can leave a size between the presets.
        if (!layouts.some(option => option.value === layout)) layouts.splice(4, 0, { value: layout, label: tr('图标（{0} 像素）', defaults.iconSize) });
        return <>
          <div className="settings-fields">
          <label className="settings-language"><span>{tr('默认布局')}</span><select aria-label={tr('默认布局')} value={layout} disabled={!settings || busy} onChange={event => {
            const [view, size] = event.target.value.split(':');
            change(view === 'icons' ? { view: 'icons', iconSize: Number(size) } : { view: view as FolderView['view'] });
          }}>{layouts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="settings-language"><span>{tr('默认排序')}</span><select aria-label={tr('默认排序')} value={defaults.sort} disabled={!settings || busy} onChange={event => change({ sort: event.target.value as FolderView['sort'] })}>
            <option value="name">{tr('名称')}</option><option value="modified">{tr('修改日期')}</option><option value="type">{tr('类型')}</option><option value="size">{tr('大小')}</option>
          </select></label>
          <label className="settings-language"><span>{tr('排序方向')}</span><select aria-label={tr('排序方向')} value={defaults.ascending ? 'ascending' : 'descending'} disabled={!settings || busy} onChange={event => change({ ascending: event.target.value === 'ascending' })}>
            <option value="ascending">{tr('递增')}</option><option value="descending">{tr('递减')}</option>
          </select></label>
          </div>
          <p className="settings-note">{tr('在文件夹中更改布局或排序只影响该文件夹，其余文件夹使用这里的默认值。')}</p>
          <div className="settings-reset-row"><button type="button" className="secondary-button" disabled={!settings || busy} onClick={() => void save(async () => { const value = await api.resetFolderViews(); setFoldersReset(true); return value; })}>{tr('重置所有文件夹')}</button>
            {foldersReset && <span className="settings-note" role="status">{tr('所有文件夹已跟随默认值。')}</span>}</div>
        </>;
      })()}</fieldset>
    </div>
    <div className="settings-panel" id={`${id}-panel-toolbar`} role="tabpanel" aria-labelledby={`${id}-tab-toolbar`} hidden={section !== 'toolbar'} tabIndex={0}>
      <p className="settings-note">{tr('勾选显示按钮，使用箭头调整顺序。更改自动保存。')}</p>
      <div className="toolbar-options" role="group" aria-label={tr('工具栏按钮')}>
        {[...toolbar, ...toolbarActions.filter(id => !toolbar.includes(id))].map(id => {
          const index = toolbar.indexOf(id); const tool = tools[id];
          const move = (offset: number) => { const next = [...toolbar]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onToolbarChange(next); };
          return <div className="toolbar-option" key={id}>
            <label><input type="checkbox" checked={index >= 0} disabled={busy} onChange={event => onToolbarChange(event.target.checked ? [...toolbar, id] : toolbar.filter(value => value !== id))}/>{tool.icon}<span>{tool.name}</span></label>
            <button aria-label={tr('上移{0}', tool.name)} title={tr('上移{0}', tool.name)} disabled={busy || index <= 0} onClick={() => move(-1)}><ArrowUp size={15}/></button>
            <button aria-label={tr('下移{0}', tool.name)} title={tr('下移{0}', tool.name)} disabled={busy || index < 0 || index === toolbar.length - 1} onClick={() => move(1)}><ArrowDown size={15}/></button>
          </div>;
        })}
      </div>
      <button className="secondary-button toolbar-reset" disabled={busy} onClick={() => onToolbarChange([...defaultToolbar])}>{tr('恢复默认工具栏')}</button>
    </div>
    <div className="settings-panel" id={`${id}-panel-shortcuts`} role="tabpanel" aria-labelledby={`${id}-tab-shortcuts`} hidden={section !== 'shortcuts'} tabIndex={0}>

      <section className="settings-shortcuts"><h3>{tr('文件操作快捷键')}</h3>
        <p className="settings-note">{tr('点击组合键框后按键录入；自定义会替换该操作的原有组合。')}</p>
        <div className="operation-shortcuts">
          {shortcutActionIDs.map(action => {
            const label = tr(shortcutActions[action].label);
            const values = bindingsFor(action, operationDraft);
            return <div className="operation-shortcut" key={action}>
              <label htmlFor={`${id}-shortcut-${action}`}>{label}</label>
              <input id={`${id}-shortcut-${action}`} aria-label={tr('{0}的快捷键', label)} title={values.map(formatShortcut).join(' / ')} placeholder={tr('未设置')} readOnly disabled={!settings || busy} value={values.map(formatShortcut).join(' / ')} onKeyDown={event => {
                if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return;
                event.preventDefault(); event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Escape') { event.currentTarget.blur(); return; }
                const value = shortcutFromEvent(event);
                if (value) { setOperationDraft(previous => ({ ...previous, [action]: [value] })); setError(''); }
              }}/>
              <div className="shortcut-row-actions"><button aria-label={tr('清除“{0}”的快捷键', label)} title={tr('清除')} disabled={!settings || busy || !values.length} onClick={() => { setOperationDraft(previous => ({ ...previous, [action]: [] })); setError(''); }}><X size={15}/></button>
              <button aria-label={tr('恢复“{0}”的默认快捷键', label)} title={tr('恢复默认')} disabled={!settings || busy || !Object.hasOwn(operationDraft, action)} onClick={() => { setOperationDraft(previous => { const next = { ...previous }; delete next[action]; return next; }); setError(''); }}><RotateCw size={14}/></button></div>
            </div>;
          })}
        </div>
        <p className="settings-note">{tr('检查操作之间、唤醒快捷键及常见系统保留组合的冲突。输入框保留文本编辑快捷键。')}</p>
        <div className="operation-shortcut-feedback">
          {operationConflict && <p className="settings-shortcut-error" role="alert">{operationConflict}</p>}
          <div className="shortcut-save-actions"><button className="secondary-button" disabled={!settings || busy || !Object.keys(operationDraft).length} onClick={() => { setOperationDraft({}); setError(''); }}>{tr('恢复默认快捷键')}</button>
          <button className="primary-button" disabled={!settings || busy || !operationsChanged || !!operationConflict} onClick={() => void save(async () => { const value = await api.setOperationShortcuts(operationDraft); setOperationDraft(value.operationShortcuts); return value; })}>{tr('保存操作快捷键')}</button></div>
        </div>
      </section>
    <fieldset className="settings-group"><legend>{tr('唤醒快捷键')}</legend><p>{tr('设置后可从任何应用唤醒 Mac Explorer。')}</p>
      <div className="shortcut-setting"><input aria-label={tr('唤醒快捷键')} placeholder={tr('点击后按下快捷键')} readOnly value={display} disabled={!settings || busy} onKeyDown={event => {
        if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return;
        event.stopPropagation(); event.preventDefault();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.currentTarget.blur(); return; }
        if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
        const next = shortcutFromEvent(event);
        if (next) setShortcut(next);
        setError('');
      }}/><button className="secondary-button" disabled={!shortcut || busy} onClick={() => setShortcut('')}>{tr('清除')}</button></div>
      <p className="settings-note">{tr('请使用修饰键组合或 F1–F24 功能键。')}</p>
      {wakeConflict && <p className="settings-shortcut-error" role="alert">{wakeConflict}</p>}
      <button className="primary-button" disabled={!settings || busy || !!wakeConflict || shortcut === settings.wakeShortcut && !settings.wakeShortcutError} onClick={() => void save(() => api.setWakeShortcut(shortcut))}>{tr('保存快捷键')}</button>
    </fieldset>
    </div>
    <div className="settings-panel" id={`${id}-panel-about`} role="tabpanel" aria-labelledby={`${id}-tab-about`} hidden={section !== 'about'} tabIndex={0}>
      <AboutPanel/>
    </div>
    {error && <p className="modal-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="primary-button" disabled={busy} onClick={onClose}>{tr('关闭')}</button></div>
  </dialog>;
}


function Loading() { return <div className="loading-state" aria-label={tr('正在读取文件')}><div/><div/><div/><div/><div/></div>; }
function ContextMenu({ popup, onClose, parentButton, label }: { popup: Popup; onClose: () => void; parentButton?: HTMLButtonElement; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const hasMarks = popup.items.some(item => item.checked !== undefined);
  const [position, setPosition] = useState({ left: popup.x, top: popup.y });
  const [submenu, setSubmenu] = useState<{ item: MenuItem; button: HTMLButtonElement } | null>(null);
  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    const anchor = parentButton?.getBoundingClientRect();
    const x = anchor ? anchor.right + 5 + rect.width <= window.innerWidth - 8 ? anchor.right + 5 : anchor.left - rect.width - 5 : popup.x;
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(anchor?.top ?? popup.y, window.innerHeight - rect.height - 8)) });
    setSubmenu(null);
    if (!parentButton) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [popup, parentButton]);
  useEffect(() => {
    const dismiss = () => onClose();
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [onClose]);
  const openSubmenu = (item: MenuItem, button: HTMLButtonElement, focus = false) => {
    setSubmenu({ item, button });
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.context-submenu button:not(:disabled)')?.focus());
  };
  return <><div className={`context-menu ${parentButton ? 'context-submenu' : ''}`} role="menu" aria-label={label} ref={ref} style={position} onPointerDown={e => e.stopPropagation()} onScroll={() => setSubmenu(null)} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'ArrowLeft' && parentButton) { event.preventDefault(); onClose(); parentButton?.focus(); }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); setSubmenu(null);
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }
  }}>{popup.quickActions && <><div className="menu-quick-actions">{popup.quickActions.map(item => <button key={item.label} role="menuitem" title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label} disabled={item.disabled} onClick={() => { onClose(); item.action?.(); }}><span className="menu-icon">{item.icon}</span><span>{item.label}</span></button>)}</div><div className="menu-divider"/></>}{popup.items.map((item, i) => <div key={i}>{item.divider && <div className="menu-divider"/>}<button aria-label={item.label} aria-description={item.shortcut || undefined} role={item.radio ? 'menuitemradio' : item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={item.checked} aria-haspopup={item.children ? 'menu' : undefined} aria-expanded={item.children ? submenu?.item === item : undefined} disabled={item.disabled} className={item.danger ? 'danger-item' : ''}
    onMouseEnter={event => { if (item.children) openSubmenu(item, event.currentTarget); else setSubmenu(null); }}
    onKeyDown={event => { if (item.children && event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openSubmenu(item, event.currentTarget, true); } }}
    onClick={event => { if (item.children) openSubmenu(item, event.currentTarget, true); else { onClose(); item.action?.(); } }}>
    {hasMarks && <span className="menu-mark">{item.checked && (item.radio ? <span className="menu-radio-dot"/> : <Check size={12}/>)}</span>}<span className="menu-icon">{item.icon}</span><span className="menu-label">{item.label}</span>{item.children ? <ChevronRight className="submenu-arrow" size={14}/> : <kbd>{item.shortcut}</kbd>}</button></div>)}</div>
    {submenu?.item.children && createPortal(<ContextMenu popup={{ x: 0, y: 0, items: submenu.item.children.map(item => ({ ...item, action: () => { onClose(); item.action?.(); } })) }} parentButton={submenu.button} label={submenu.item.label} onClose={() => setSubmenu(null)}/>, document.body)}
  </>;
}

function InlineName({ name, directory, onSave, onCancel }: { name: string; directory: boolean; onSave: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name); const ref = useRef<HTMLInputElement>(null); const canceled = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.setSelectionRange(0, !directory && name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length); }, []);
  return <input className="inline-name" ref={ref} aria-label={tr('名称')} value={value} onChange={event => setValue(event.target.value)} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onBlur={() => { if (!canceled.current) onSave(value); }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); onSave(value); }
    if (event.key === 'Escape') { event.preventDefault(); canceled.current = true; onCancel(); }
  }}/>;
}

function NavigationTree({ place, folderIcon, location, hidden, navigate, newTab, drop, context, pinned = false, reorder, level = 0, eject, ejecting = false }: {
  place: Place; folderIcon: (path: string) => string | undefined; location: string; hidden: boolean; navigate: (path: string) => void; newTab: (path: string) => void;
  drop: (event: React.DragEvent, path: string) => void; context: (event: MouseEvent, place: Place) => void; pinned?: boolean; level?: number;
  reorder?: { over: (event: React.DragEvent) => boolean; drop: (event: React.DragEvent) => boolean }; eject?: () => void; ejecting?: boolean;
}) {
  const [expanded, setExpanded] = useState(false); const [children, setChildren] = useState<FileEntry[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [over, setOver] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let live = true; setLoading(true); setError('');
    api.list(place.path).then(result => { if (live) setChildren(result.entries.filter(e => e.isDirectory && !e.isSymlink && !e.name.endsWith('.app') && (hidden || !e.hidden)).sort((a, b) => a.name.localeCompare(b.name, getLocale(), { numeric: true }))); }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [expanded, place.path, hidden, location]);
  return <div className="tree-node">
    <div className={`tree-row ${location === place.path ? 'current' : ''} ${over ? 'drop-target' : ''}`} draggable={!!reorder}
      onDragStart={reorder && (event => { event.dataTransfer.setData(PLACE_TYPE, place.path); event.dataTransfer.effectAllowed = 'move'; })}
      onDragOver={event => { if (reorder?.over(event)) { setOver(false); return; } if (isPlaceDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(true); }}
      onDragLeave={() => setOver(false)} onDrop={event => { setOver(false); if (!reorder?.drop(event)) drop(event, place.path); }}>
      <button className="tree-toggle" style={{ left: 1 + level * 12 }} aria-label={`${expanded ? tr('折叠') : tr('展开')} ${place.name}`} aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{loading ? <Loader2 size={11} className="spinning"/> : <ChevronRight size={11}/>}</button>
      <button className={`nav-item ${location === place.path ? 'current' : ''}`} style={{ paddingLeft: 24 + level * 12, paddingRight: eject ? 36 : undefined }} onClick={() => navigate(place.path)} onAuxClick={event => { if (event.button === 1) newTab(place.path); }} onContextMenu={event => context(event, place)}>
        {place.icon === 'folder' ? <FolderGlyph dimension={20}/> : <PlaceIcon icon={place.icon}/>}<span>{place.name}</span>{pinned && <Pin size={12} className="pin-mark"/>}
      </button>
      {eject && <button className="volume-eject" aria-label={tr('推出“{0}”', place.name)} title={tr('推出“{0}”', place.name)} disabled={ejecting} onClick={event => { event.stopPropagation(); eject(); }}><Eject size={15}/></button>}
    </div>
    {expanded && <div role="group" aria-label={tr('{0} 的子文件夹', place.name)}>{error ? <p className="tree-note" title={error}>{tr('无法访问')}</p> : !loading && !children.length ? <p className="tree-note">{tr('没有子文件夹')}</p> : children.map(child => <NavigationTree key={child.path} place={{ path: child.path, name: child.name, icon: folderIcon(child.path) || 'folder' }} folderIcon={folderIcon} location={location} hidden={hidden} navigate={navigate} newTab={newTab} drop={drop} context={context} level={Math.min(level + 1, 6)}/>)}</div>}
  </div>;
}
function ModalDialog({ modal, value, onChange, error, busy, onClose, onSubmit }: { modal: Exclude<Modal, { kind: 'archive' | 'settings' | 'vcs' }>; value: string; onChange: (value: string) => void; error: string; busy: boolean; onClose: () => void; onSubmit: (skipTrashConfirmation?: boolean) => void }) {
  const [skipTrashConfirmation, setSkipTrashConfirmation] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null); const inputRef = useRef<HTMLInputElement>(null); const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
    const input = inputRef.current;
    // React's autoFocus runs while the dialog is still inert, so focus the confirm button
    // after showModal() — otherwise the dialog focuses the close button and Return dismisses.
    if (input) { input.focus(); const dot = value.lastIndexOf('.'); input.setSelectionRange(0, modal.kind === 'rename' && dot > 0 ? dot : value.length); }
    else if (modal.kind === 'trash') confirmRef.current?.focus();
  }, []);
  const title = modal.kind === 'trash' ? tr('移到回收站') : modal.kind === 'rename' ? tr('重命名') : modal.kind === 'folder' ? tr('新建文件夹') : tr('新建文本文档');
  return <dialog ref={dialogRef} className="modal" aria-labelledby="modal-title" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); onSubmit(modal.kind === 'trash' && skipTrashConfirmation); }}><div className="modal-heading"><h2 id="modal-title">{title}</h2><button type="button" aria-label={tr('关闭对话框')} onClick={onClose} disabled={busy}><X size={18}/></button></div>
      {modal.kind === 'trash' ? <div className="trash-description"><Trash2 size={34} strokeWidth={1.4}/><div><p>{modal.paths.length === 1 ? tr('将“{0}”移到回收站？', base(modal.paths[0])) : tr('将这 {0} 个项目移到回收站？', modal.paths.length)}</p><small>{tr('文件将移入 macOS 回收站，你可以从那里恢复。')}</small></div></div> : <><label className="name-label" htmlFor="entry-name">{tr('名称')}</label><input ref={inputRef} id="entry-name" value={value} onChange={event => onChange(event.target.value)} disabled={busy} autoComplete="off"/><p className="modal-location">{tr('位置：')}{modal.kind === 'rename' ? parent(modal.path) : modal.path}</p></>}
      {modal.kind === 'trash' && <label className="trash-confirmation-preference"><input type="checkbox" checked={skipTrashConfirmation} disabled={busy} onChange={event => setSkipTrashConfirmation(event.target.checked)}/>{tr('不再显示此提示')}</label>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{tr('取消')}</button><button type="submit" ref={confirmRef} className="primary-button" disabled={busy || modal.kind !== 'trash' && !value.trim()}>{busy ? tr('正在处理…') : modal.kind === 'trash' ? tr('移到回收站') : tr('确定')}</button></div>
    </form>
  </dialog>;
}
