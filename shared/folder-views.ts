export const viewModes = ['details', 'icons', 'list', 'tiles', 'content'] as const;
export const sortKeys = ['name', 'modified', 'type', 'size'] as const;
export type ViewMode = typeof viewModes[number];
export type SortKey = typeof sortKeys[number];
export interface FolderLayout { view: ViewMode; iconSize: number }
export interface FolderSort { sort: SortKey; ascending: boolean }
export type FolderView = FolderLayout & FolderSort;
// Layout and sort override the defaults independently; a missing group follows them.
export interface FolderViewOverride { layout?: FolderLayout; sort?: FolderSort }
// Settings kept in renderer localStorage by earlier versions.
export interface LegacyFolderViews { layouts: Record<string, FolderLayout>; sort?: FolderSort }
export type FolderViewChange = { location: string; override: FolderViewOverride | null } | { reset: true };

export const defaultFolderView: FolderView = { view: 'icons', iconSize: 64, sort: 'name', ascending: true };

export function validLayout(value: unknown): value is FolderLayout {
  const layout = value as FolderLayout;
  return !!layout && typeof layout === 'object' && viewModes.includes(layout.view) &&
    Number.isInteger(layout.iconSize) && layout.iconSize >= 32 && layout.iconSize <= 128;
}
export function validSort(value: unknown): value is FolderSort {
  const sort = value as FolderSort;
  return !!sort && typeof sort === 'object' && sortKeys.includes(sort.sort) && typeof sort.ascending === 'boolean';
}
export function validFolderView(value: unknown): value is FolderView { return validLayout(value) && validSort(value); }
export function validOverride(value: unknown): value is FolderViewOverride {
  const override = value as FolderViewOverride;
  return !!override && typeof override === 'object' && (override.layout === undefined || validLayout(override.layout)) && (override.sort === undefined || validSort(override.sort));
}

// Only edited groups can return to following the defaults; untouched overrides stay.
export function normalizeOverride(override: FolderViewOverride, defaults: FolderView, current: FolderViewOverride = {}): FolderViewOverride | null {
  const result: FolderViewOverride = { ...current };
  if (override.layout) {
    if (override.layout.view !== defaults.view || override.layout.iconSize !== defaults.iconSize) result.layout = { view: override.layout.view, iconSize: override.layout.iconSize };
    else delete result.layout;
  }
  if (override.sort) {
    if (override.sort.sort !== defaults.sort || override.sort.ascending !== defaults.ascending) result.sort = { sort: override.sort.sort, ascending: override.sort.ascending };
    else delete result.sort;
  }
  return result.layout || result.sort ? result : null;
}
export function resolveFolderView(defaults: FolderView, override?: FolderViewOverride): FolderView {
  return { ...defaults, ...override?.layout, ...override?.sort };
}
