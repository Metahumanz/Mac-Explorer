import { useEffect, useState } from 'react';
import { Download, ExternalLink, RotateCw } from 'lucide-react';
import { t as tr } from '../shared/i18n';
import type { AboutInfo, UpdateState } from '../shared/types';

const api = window.explorer;
const appIcon = new URL('../design/icon-selected-mirrored.png', import.meta.url).href;
export function AboutPanel() {
  const [about, setAbout] = useState<AboutInfo>();
  const [update, setUpdate] = useState<UpdateState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const stop = api.onUpdateChanged(state => { if (live) setUpdate(state); });
    void Promise.all([api.about(), api.updateState()]).then(([info, state]) => { if (live) { setAbout(info); setUpdate(state); } }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; stop(); };
  }, []);
  async function run(action: () => Promise<UpdateState | void>) {
    setError(''); setBusy(true);
    try { const state = await action(); if (state) setUpdate(state); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const working = busy || !!update && ['checking', 'downloading', 'verifying', 'installing'].includes(update.status);
  const statuses: Record<UpdateState['status'], string> = {
    idle: tr('手动检查 GitHub Releases 中的正式版本。'), checking: tr('正在检查更新…'),
    current: tr('当前已是最新版本。'), available: tr('发现新版本 {0}', update?.latestVersion),
    downloading: tr('正在下载更新…'), verifying: tr('正在校验更新包…'), ready: tr('更新已就绪，重启后完成安装。'),
    installing: tr('正在退出并安装更新…'), error: tr('更新未完成，可以重试。'),
  };
  const canDownload = update?.canInstall && update.latestVersion && ['available', 'error'].includes(update.status);
  return <div className="about-content">
    <div className="about-identity"><img src={appIcon} alt="" width={64} height={64}/><h3>Mac Explorer</h3><p>{about ? tr('版本 {0} · {1}', about.version, about.platform) : tr('正在读取…')}</p></div>
    <p className="about-description">{tr('在 macOS 上，延续 Windows 11 文件资源管理器的熟悉体验。')}</p>
    <section className="about-update" aria-label={tr('在线更新')}>
      <p role="status" aria-live="polite">{update ? statuses[update.status] : tr('正在读取…')}</p>
      {update && ['downloading', 'verifying'].includes(update.status) && <div className="update-progress">
        <progress aria-label={tr('更新下载进度')} value={update.downloaded} max={update.total || 1}/>
        <span>{tr('{0} / {1} MiB', (update.downloaded / 1024 ** 2).toFixed(1), (update.total / 1024 ** 2).toFixed(1))}</span>
      </div>}
      {(error || update?.error) && <p className="modal-error" role="alert">{error || update?.error}</p>}
      <div className="about-actions">
        {update?.status === 'ready' ? <button className="primary-button" disabled={working} onClick={() => void run(() => api.installUpdate())}><RotateCw size={15}/>{tr('重启并安装')}</button>
          : <><button className="secondary-button" disabled={working || !update} onClick={() => void run(() => api.checkUpdate())}>{tr('检查更新')}</button>
            {canDownload && <button className="primary-button" disabled={working} onClick={() => void run(() => api.downloadUpdate())}><Download size={15}/>{tr('下载更新')}</button>}</>}
      </div>
      <p className="settings-note">{tr('当前发布采用临时签名，未经过 Apple 公证，安装后仍可能需要系统确认。')}</p>
    </section>
    <div className="about-links">{([{ page: 'home', label: tr('项目主页') }, { page: 'releases', label: tr('GitHub 发布页') }, { page: 'issues', label: tr('问题反馈') }, { page: 'license', label: tr('开源许可') }] as const).map(link =>
      <button key={link.page} className="about-link" onClick={() => void run(() => api.openProject(link.page))}>{link.label}<ExternalLink size={12} aria-hidden="true"/></button>)}
    </div>
    <p className="settings-note about-copyright">{about ? `© 2026 ${about.author} · ${about.license}` : ''}</p>
  </div>;
}
