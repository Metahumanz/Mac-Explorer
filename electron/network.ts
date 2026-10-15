import { t as tr } from '../shared/i18n';

export function networkAddress(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x1f\x7f\\]/.test(input)) throw new Error(tr('请输入有效的 SMB 服务器地址，例如 smb://server/share。'));
  try {
    const address = new URL(input.trim());
    if (!/^smb:\/\//i.test(input.trim()) || address.protocol !== 'smb:' || !address.hostname || address.username || address.password || address.search || address.hash) throw new Error();
    return address.href;
  } catch { throw new Error(tr('请输入有效的 SMB 服务器地址，例如 smb://server/share。')); }
}
