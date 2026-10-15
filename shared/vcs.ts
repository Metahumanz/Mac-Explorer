export type VcsKind = 'git' | 'svn';
export type VcsState = 'clean' | 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' | 'ignored';
export type VcsAction = 'add' | 'commit' | 'update' | 'revert';
export interface VcsChange { path: string; state: VcsState; staged: boolean; unstaged: boolean }
export interface VcsStatus {
  root: string; kind: VcsKind; branch: string; states: Record<string, VcsState>; error?: string;
}
export interface VcsPlan { id: string; root: string; kind: VcsKind; action: VcsAction; changes: VcsChange[] }
export interface VcsDiff { working: string; staged: string }
export interface VcsResult { output: string; backup?: string }

export const vcsMarks: Record<VcsState, string> = { clean: '✓', modified: 'M', added: '+', deleted: 'D', untracked: '?', conflict: '!', ignored: '−' };
