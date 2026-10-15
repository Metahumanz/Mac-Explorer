export const toolbarActions = ['cut', 'copy', 'paste', 'rename', 'share', 'trash', 'airdrop', 'terminal', 'undo', 'refresh'] as const;
export type ToolbarAction = typeof toolbarActions[number];
export const defaultToolbar: ToolbarAction[] = ['cut', 'copy', 'paste', 'rename', 'share', 'trash'];

export function normalizeToolbar(value: unknown): ToolbarAction[] {
  if (!Array.isArray(value)) return [...defaultToolbar];
  return [...new Set(value.filter((item): item is ToolbarAction => toolbarActions.includes(item)))];
}
