import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultFolderView, normalizeOverride, validFolderView, validLayout, validOverride, validSort, type FolderView, type FolderViewOverride, type LegacyFolderViews } from '../shared/folder-views';

// Per-location overrides capped like Explorer's folder view history.
// Map order is recency order, oldest first: opening or changing a location
// moves it to the end, and the oldest entries are evicted past the limit.
export class FolderViews {
  private savedDefaults: FolderView | null = null;
  private folders = new Map<string, FolderViewOverride>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, private limit = 5000) {}

  get defaults(): FolderView { return this.savedDefaults ?? defaultFolderView; }
  overrides(): Record<string, FolderViewOverride> { return Object.fromEntries(this.folders); }

  load() {
    return this.loaded ??= fs.readFile(this.file, 'utf8').then(text => {
      const saved = JSON.parse(text);
      if (validFolderView(saved.defaults)) this.savedDefaults = pickView(saved.defaults);
      for (const [location, override] of Array.isArray(saved.folders) ? saved.folders : []) {
        // Not normalized: an override may equal defaults changed after it was set.
        const picked = typeof location === 'string' && validOverride(override) ? pickOverride(override) : null;
        if (picked) this.folders.set(location, picked);
      }
    }).catch(() => { /* Missing or unreadable settings start from the defaults. */ });
  }
  // Returns the stored override, or null when every group matches the defaults.
  async set(location: string, override: FolderViewOverride) {
    await this.load();
    const normalized = normalizeOverride(override, this.defaults);
    this.folders.delete(location);
    if (normalized) this.folders.set(location, normalized);
    this.evict();
    await this.save();
    return normalized;
  }
  async setDefaults(defaults: FolderView) {
    await this.load();
    this.savedDefaults = pickView(defaults);
    await this.save();
  }
  async reset(defaults?: FolderView) {
    await this.load();
    if (defaults) this.savedDefaults = pickView(defaults);
    this.folders.clear();
    await this.save();
  }
  // Legacy layouts are newer than stored ones because earlier versions only
  // wrote localStorage; the legacy global sort seeds unsaved defaults.
  async importLegacy(legacy: LegacyFolderViews) {
    await this.load();
    if (!this.savedDefaults && legacy.sort && validSort(legacy.sort)) this.savedDefaults = { ...defaultFolderView, sort: legacy.sort.sort, ascending: legacy.sort.ascending };
    for (const [location, layout] of Object.entries(legacy.layouts)) {
      if (!validLayout(layout)) continue;
      const normalized = normalizeOverride({ ...this.folders.get(location), layout }, this.defaults);
      this.folders.delete(location);
      if (normalized) this.folders.set(location, normalized);
    }
    this.evict();
    await this.save();
  }
  // Opening a location marks it recent; a folder that no longer exists loses
  // its entry. Other stat failures (permissions, timeouts) keep it.
  async touch(location: string) {
    await this.load();
    if (!this.folders.has(location)) return;
    const exists = !path.isAbsolute(location) || await fs.stat(location).then(stat => stat.isDirectory(), (error: NodeJS.ErrnoException) => error.code !== 'ENOENT' && error.code !== 'ENOTDIR');
    const override = this.folders.get(location);
    if (!override) return;
    this.folders.delete(location);
    if (exists) this.folders.set(location, override);
    this.timer ??= setTimeout(() => { this.timer = null; this.save().catch(() => { /* Recency is retried on the next write. */ }); }, 1000);
  }

  private evict() {
    for (const oldest of this.folders.keys()) {
      if (this.folders.size <= this.limit) break;
      this.folders.delete(oldest);
    }
  }
  private save() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const data = JSON.stringify({ defaults: this.savedDefaults, folders: [...this.folders] });
    const write = this.saving.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + '.tmp', data, 'utf8');
      await fs.rename(this.file + '.tmp', this.file);
    });
    this.saving = write.catch(() => {});
    return write;
  }
}
function pickOverride(value: FolderViewOverride): FolderViewOverride | null {
  const result: FolderViewOverride = {};
  if (value.layout) result.layout = { view: value.layout.view, iconSize: value.layout.iconSize };
  if (value.sort) result.sort = { sort: value.sort.sort, ascending: value.sort.ascending };
  return result.layout || result.sort ? result : null;
}
function pickView(value: FolderView): FolderView {
  return { view: value.view, iconSize: value.iconSize, sort: value.sort, ascending: value.ascending };
}
