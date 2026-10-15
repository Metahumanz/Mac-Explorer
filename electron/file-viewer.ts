import { app } from 'electron';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { t as tr } from '../shared/i18n';
import type { FileViewerSettings } from '../shared/types';

let changing = false;
export async function fileViewerSettings(enabled?: boolean): Promise<FileViewerSettings> {
  const available = process.platform === 'darwin' && (app.isPackaged || !!process.env.EXPLORER_TEST_ROOT);
  if (!available) {
    if (enabled !== undefined) throw new Error(tr('请在打包后的 Mac Explorer 中设置文件查看器。'));
    return { enabled: false, canRestore: false, available: false, error: '' };
  }
  if (changing) throw new Error(tr('设置正在保存，请稍后重试。'));
  if (enabled !== undefined) changing = true;
  try {
    const helper = path.join(__dirname.replace(/app\.asar(?=\/)/, 'app.asar.unpacked'), 'native/file-viewer');
    const backup = path.join(app.getPath('userData'), 'file-viewer-backup.plist');
    const { stdout } = await promisify(execFile)(helper, [enabled === undefined ? 'status' : enabled ? 'enable' : 'restore', backup], { timeout: 15_000, maxBuffer: 128 * 1024 });
    const state = JSON.parse(stdout) as Omit<FileViewerSettings, 'available'>;
    if (typeof state.enabled !== 'boolean' || typeof state.canRestore !== 'boolean' || typeof state.error !== 'string') throw new Error(tr('无法读取文件查看器设置。'));
    return { ...state, available, error: state.error ? tr(state.error) : '' };
  } catch (error) {
    throw new Error(tr((error as { stderr?: string }).stderr?.trim() || (error as Error).message));
  } finally { if (enabled !== undefined) changing = false; }
}
