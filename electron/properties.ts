import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { absolute, entryFor } from './files';
import type { FileProperties } from '../shared/types';

export async function fileProperties(inputs: string[], signal?: AbortSignal): Promise<FileProperties> {
  const paths = [...new Set(inputs.map(absolute))];
  if (!paths.length) throw new Error('请选择文件或文件夹。');
  signal?.throwIfAborted();
  const entries = [];
  for (let index = 0; index < paths.length; index += 64) {
    signal?.throwIfAborted();
    entries.push(...await Promise.all(paths.slice(index, index + 64).map(entryFor)));
  }
  const directories = new Set(entries.filter(entry => entry.isDirectory && !entry.isSymlink).map(entry => entry.path));
  const roots = entries.filter(entry => {
    for (let ancestor = path.dirname(entry.path); ancestor !== entry.path; ancestor = path.dirname(ancestor)) {
      if (directories.has(ancestor)) return false;
      if (ancestor === '/') break;
    }
    return true;
  });
  const result: FileProperties = { entries, size: 0, allocated: 0, files: 0, folders: 0, skipped: 0, symlinks: 0, readOnly: null };
  const rootPaths = new Set(roots.map(entry => entry.path));
  const queue = [...rootPaths];
  const allocated = new Set<string>();
  while (queue.length) {
    signal?.throwIfAborted();
    const current = queue.pop()!;
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (rootPaths.has(current)) throw error; result.skipped++; continue; }
    if (stat.isDirectory()) {
      if (!rootPaths.has(current)) result.folders++;
      try { for (const name of await fs.readdir(current)) queue.push(path.join(current, name)); }
      catch (error) { if (signal?.aborted) throw error; result.skipped++; }
    } else {
      result.files++;
      result.size += stat.size;
      if (stat.isSymbolicLink()) result.symlinks++;
      // Count hard-linked data once; st_blocks uses 512-byte allocation units on macOS.
      const key = `${stat.dev}:${stat.ino}`;
      if (!allocated.has(key)) { result.allocated += stat.blocks * 512; allocated.add(key); }
    }
  }
  signal?.throwIfAborted();
  if (entries.length === 1) result.readOnly = await fs.access(entries[0].path, constants.W_OK).then(() => false, () => true);
  return result;
}
