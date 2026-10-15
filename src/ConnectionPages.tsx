import { useEffect, useState } from 'react';
import { FolderOpen, Globe, Loader2, Monitor, Radar, RotateCw } from 'lucide-react';
import { t as tr } from '../shared/i18n';
import type { NetworkServer, Volume } from '../shared/types';

export function AirDropPage({ busy, choose }: { busy: boolean; choose: () => void }) {
  return <section className="connection-page airdrop-page" aria-labelledby="airdrop-title">
    <h1 id="airdrop-title">{tr('隔空投送')}</h1>
    <p className="connection-description">{tr('将文件发送给附近的 Mac、iPhone 或 iPad。')}</p>
    <div className="airdrop-target">
      <Radar size={56} strokeWidth={1.25} aria-hidden="true"/>
      <h2>{tr('拖入要发送的文件')}</h2>
      <p>{tr('也可以选择文件，然后在系统窗口中选择接收设备。')}</p>
      <button className="primary-button" disabled={busy} onClick={choose}>{busy ? tr('正在打开隔空投送…') : tr('选择文件…')}</button>
    </div>
    <p className="connection-help">{tr('请开启无线局域网和蓝牙，并让接收设备允许被发现。')}</p>
  </section>;
}

export function NetworkPage({ volumes, refresh, query, busy, connect, open, rescan }: {
  volumes: Volume[]; refresh: number; query: string; busy: boolean;
  connect: (address: string) => void; open: (path: string) => void; rescan: () => void;
}) {
  const [address, setAddress] = useState('smb://');
  const [servers, setServers] = useState<NetworkServer[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setDiscovering(true); setError('');
    window.explorer.discoverNetwork().then(value => { if (live) setServers(value); }).catch(error => {
      if (live) { setServers([]); setError(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    }).finally(() => { if (live) setDiscovering(false); });
    return () => { live = false; };
  }, [refresh]);
  const matches = (name: string) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const mounted = volumes.filter(volume => volume.isNetwork && matches(volume.name));
  const found = servers.filter(server => matches(server.name) || matches(server.address));
  return <section className="connection-page network-page" aria-labelledby="network-title">
    <h1 id="network-title">{tr('网络')}</h1>
    <p className="connection-description">{tr('浏览局域网中的共享电脑，或输入服务器地址连接。')}</p>
    <form className="network-connect" onSubmit={event => { event.preventDefault(); connect(address); }}>
      <label htmlFor="network-address">{tr('服务器地址')}</label>
      <div><input id="network-address" value={address} onChange={event => setAddress(event.target.value)} placeholder="smb://server/share" maxLength={2048} autoCapitalize="off" autoCorrect="off" spellCheck={false}/>
        <button className="primary-button" disabled={busy || !address.trim() || address.trim() === 'smb://'}>{busy ? tr('正在连接…') : tr('连接')}</button></div>
      <p>{tr('支持 SMB 共享；账号和密码由 macOS 登录窗口处理。')}</p>
    </form>
    {mounted.length > 0 && <section className="network-section" aria-labelledby="network-mounted"><h2 id="network-mounted">{tr('已连接的共享')}</h2><ul>
      {mounted.map(volume => <li className="network-device" key={volume.path}><FolderOpen size={28} aria-hidden="true"/><span><strong>{volume.name}</strong><small>{volume.path}</small></span><button className="secondary-button" onClick={() => open(volume.path)}>{tr('打开')}</button></li>)}
    </ul></section>}
    <section className="network-section" aria-labelledby="network-discovered">
      <div className="network-section-heading"><h2 id="network-discovered">{tr('附近的共享电脑')}</h2><button className="secondary-button" disabled={discovering} onClick={rescan}><RotateCw size={14} aria-hidden="true"/>{tr('重新查找')}</button></div>
      {error && <p className="network-error" role="alert">{error}</p>}
      {discovering ? <p className="network-status" role="status"><Loader2 size={16} className="spinning" aria-hidden="true"/>{tr('正在查找共享电脑…')}</p> : found.length ? <ul>
        {found.map(server => <li className="network-device" key={server.address}><Monitor size={28} aria-hidden="true"/><span><strong>{server.name}</strong><small>{server.address}</small></span><button className="secondary-button" disabled={busy} onClick={() => connect(server.address)} aria-label={tr('连接“{0}”', server.name)}>{tr('连接')}</button></li>)}
      </ul> : <div className="network-empty"><Globe size={32} strokeWidth={1.3} aria-hidden="true"/><h3>{query ? tr('没有找到匹配的项目') : tr('未发现共享设备')}</h3><p>{tr('可输入服务器地址连接。请确认设备位于同一局域网，并已开启文件共享。')}</p></div>}
    </section>
  </section>;
}
