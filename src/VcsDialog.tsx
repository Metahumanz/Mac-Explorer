import { useEffect, useId, useRef, useState } from 'react';
import { FileDiff, GitBranch, Loader2, X } from 'lucide-react';
import { t as tr } from '../shared/i18n';
import { vcsMarks, type VcsAction, type VcsDiff, type VcsKind, type VcsPlan, type VcsResult, type VcsState } from '../shared/vcs';

const api = window.explorer;
export function vcsStateLabel(state: VcsState): string {
  return { clean: tr('无本地修改'), modified: tr('已修改'), added: tr('已添加'), deleted: tr('已删除'), untracked: tr('未跟踪'), conflict: tr('存在冲突'), ignored: tr('已忽略') }[state];
}
function message(error: unknown) { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

export function VcsDialog({ directory, paths, action, enabled, onClose, onChanged }: {
  directory: string; paths: string[]; action: VcsAction | 'diff'; enabled: boolean; onClose: () => void; onChanged: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lock = useRef(false);
  const id = useId();
  const [plan, setPlan] = useState<VcsPlan | null>(null);
  const [diff, setDiff] = useState<VcsDiff | null>(null);
  const [kind, setKind] = useState<VcsKind>('git');
  const [staged, setStaged] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VcsResult | null>(null);
  const [retry, setRetry] = useState(0);
  const title = action === 'diff' ? tr('查看差异') : action === 'commit' ? tr('提交更改') : action === 'add' ? tr('加入版本控制') : action === 'update' ? tr('更新仓库') : tr('丢弃本地修改');
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setPlan(null); setDiff(null);
    const load = async () => {
      if (!enabled) throw new Error(tr('版本控制集成已关闭。'));
      if (action !== 'diff') {
        const value = await api.vcsPrepare(directory, action, paths);
        if (live) { setPlan(value); setKind(value.kind); }
      } else {
        const status = await api.vcsStatus(directory);
        if (!status || status.error) throw new Error(status?.error || tr('此位置不属于版本控制仓库。'));
        const value = await api.vcsDiff(directory, paths);
        if (live) { setKind(status.kind); setDiff(value); setStaged(!value.working && !!value.staged); }
      }
    };
    void load().catch(e => { if (live) setError(message(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [directory, paths, action, retry, enabled]);
  useEffect(() => { if (plan && action === 'commit') input.current?.focus(); }, [plan, action]);
  const close = () => { if (!lock.current) onClose(); };
  const execute = async () => {
    if (!plan || lock.current || !enabled) return;
    lock.current = true; setBusy(true); setError('');
    try { setResult(await api.vcsExecute(plan.id, text)); setPlan(null); onChanged(); }
    catch (e) { setError(message(e)); setPlan(null); onChanged(); }
    finally { lock.current = false; setBusy(false); }
  };
  const content = staged ? diff?.staged : diff?.working;
  return <dialog ref={ref} className="modal vcs-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-heading"><h2 id={`${id}-title`}><GitBranch size={19}/>{title}</h2><button aria-label={tr('关闭对话框')} disabled={busy} onClick={close}><X size={18}/></button></div>
    <div className="vcs-dialog-body" aria-busy={loading || busy}>
      <p className="vcs-location">{plan?.root || directory}</p>
      {loading && <p role="status"><Loader2 size={15} className="spinning"/> {tr('正在读取版本状态…')}</p>}
      {plan && <>
        <p className="vcs-operation-note">{action === 'commit' ? kind === 'git' ? tr('提交整个仓库的已暂存内容；未暂存修改不会提交。请核对下方完整清单。') : tr('提交下列版本控制更改到 SVN 服务器。')
          : action === 'update' ? kind === 'git' ? tr('更新整个仓库，仅允许快进；分支分叉时停止，不自动合并或变基。') : tr('更新整个工作副本；发现冲突时保留冲突，交由你处理。')
          : action === 'revert' ? kind === 'git' ? tr('将下列文件恢复到暂存区版本，保留已暂存内容和未跟踪文件。操作前会保存文件备份。') : tr('撤销下列文件的本地内容、属性及添加/删除计划。操作前会备份文件和属性。')
          : kind === 'git' ? tr('将下列文件的当前内容加入暂存区，包含新增、修改和删除；暂不提交。') : tr('将下列项目加入 SVN 版本控制；目录包含其下未忽略的文件。')}</p>
        {plan.changes.length > 0 && <ul className="vcs-changes" aria-label={tr('此次操作的文件清单')}>{plan.changes.map(change => <li key={change.path}><span className={`vcs-change-mark vcs-${change.state}`} aria-label={vcsStateLabel(change.state)}>{vcsMarks[change.state]}</span><span>{change.path}</span><small>{kind === 'git' ? change.staged && change.unstaged ? tr('已暂存及未暂存') : change.staged ? tr('已暂存') : tr('未暂存') : vcsStateLabel(change.state)}</small></li>)}</ul>}
        {action === 'commit' && <label className="vcs-message">{tr('提交信息')}<textarea ref={input} aria-label={tr('提交信息')} rows={3} maxLength={10000} value={text} disabled={busy} onChange={event => setText(event.target.value)}/></label>}
        {(action === 'commit' && kind === 'svn' || action === 'update') && <p className="settings-note">{tr('使用本机已配置的认证。需要交互式登录或证书确认时，请先在终端完成。')}</p>}
      </>}
      {diff && <>
        {kind === 'git' && <div className="vcs-diff-tabs" role="tablist" aria-label={tr('差异来源')} onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); const next = event.key === 'Home' ? false : event.key === 'End' ? true : !staged;
            setStaged(next); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next ? 1 : 0]?.focus();
          }
        }}><button id={`${id}-working`} role="tab" tabIndex={staged ? -1 : 0} aria-selected={!staged} aria-controls={`${id}-diff`} onClick={() => setStaged(false)}>{tr('未暂存')}</button><button id={`${id}-staged`} role="tab" tabIndex={staged ? 0 : -1} aria-selected={staged} aria-controls={`${id}-diff`} onClick={() => setStaged(true)}>{tr('已暂存')}</button></div>}
        <div id={`${id}-diff`} role="tabpanel" aria-labelledby={kind === 'git' ? `${id}-${staged ? 'staged' : 'working'}` : undefined}>
          {content ? <pre className="vcs-diff"><code>{content.split('\n').slice(0, 3000).map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : line.startsWith('@@') ? 'diff-heading' : ''}>{line || ' '}{'\n'}</span>)}</code></pre> : <p><FileDiff size={17}/> {tr('没有可显示的差异。未跟踪文件请先加入版本控制；二进制文件仅显示摘要。')}</p>}
          {!!content && content.split('\n').length > 3000 && <p>{tr('仅显示前 3,000 行差异，请在终端查看完整内容。')}</p>}
        </div>
      </>}
      {result && <div className="vcs-result" role="status"><p>{tr('操作已完成。')}</p>{result.output && <pre>{result.output}</pre>}{result.backup && <><p>{tr('修改前的文件备份保存在：{0}', result.backup)}</p><button className="secondary-button" onClick={() => void api.reveal(result.backup!).catch(e => setError(message(e)))}>{tr('显示备份文件夹')}</button></>}</div>}
      {error && <p className="modal-error" role="alert">{error}</p>}
    </div>
    <div className="vcs-dialog-actions"><button className="secondary-button" disabled={busy} onClick={close}>{result || action === 'diff' ? tr('关闭') : tr('取消')}</button>{error && enabled && <button className="secondary-button" disabled={busy || loading} onClick={() => setRetry(value => value + 1)}>{tr('重新预览')}</button>}{plan && <button className={action === 'revert' ? 'danger-button' : 'primary-button'} disabled={!enabled || busy || loading || action === 'commit' && !text.trim()} onClick={() => void execute()}>{busy ? tr('正在处理…') : action === 'commit' ? tr('确认提交') : action === 'add' ? tr('确认加入') : action === 'update' ? tr('确认更新') : tr('备份并丢弃修改')}</button>}</div>
  </dialog>;
}
