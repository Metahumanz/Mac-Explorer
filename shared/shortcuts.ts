import { t as tr } from './i18n';

export const shortcutActions = {
  rename: { label: '重命名', defaults: ['Enter', 'F2'] },
  open: { label: '打开项目', defaults: ['Command+O', 'Command+Down'] },
  copy: { label: '复制', defaults: ['Command+C', 'Control+C'] },
  cut: { label: '剪切', defaults: ['Command+X', 'Control+X'] },
  paste: { label: '粘贴', defaults: ['Command+V', 'Control+V'] },
  undo: { label: '撤销', defaults: ['Command+Z', 'Control+Z'] },
  'move-here': { label: '移动已复制的文件', defaults: ['Command+Alt+V'] },
  duplicate: { label: '创建副本', defaults: ['Command+D'] },
  'select-all': { label: '全选', defaults: ['Command+A', 'Control+A'] },
  'new-folder': { label: '新建文件夹', defaults: ['Command+Shift+N', 'Control+Shift+N'] },
  trash: { label: '移到回收站', defaults: ['Command+Backspace', 'Command+Delete'] },
  'quick-look': { label: '快速查看', defaults: ['Space', 'Command+Y'] },
  back: { label: '后退', defaults: ['Command+[', 'Alt+Left'] },
  forward: { label: '前进', defaults: ['Command+]', 'Alt+Right'] },
  parent: { label: '上一级', defaults: ['Command+Up', 'Alt+Up', 'Backspace'] },
  address: { label: '前往文件夹', defaults: ['Command+Shift+G', 'Control+L', 'Alt+D'] },
  search: { label: '搜索文件', defaults: ['Command+F', 'Control+F', 'Control+E'] },
  'new-tab': { label: '新建标签页', defaults: ['Command+T', 'Control+T'] },
  'close-tab': { label: '关闭标签页', defaults: ['Command+W', 'Control+W'] },
  'next-tab': { label: '下一个标签页', defaults: ['Control+Tab'] },
  'previous-tab': { label: '上一个标签页', defaults: ['Control+Shift+Tab'] },
  'tab-1': { label: '切换到第 1 个标签页', defaults: ['Command+1'] },
  'tab-2': { label: '切换到第 2 个标签页', defaults: ['Command+2'] },
  'tab-3': { label: '切换到第 3 个标签页', defaults: ['Command+3'] },
  'tab-4': { label: '切换到第 4 个标签页', defaults: ['Command+4'] },
  'tab-5': { label: '切换到第 5 个标签页', defaults: ['Command+5'] },
  'tab-6': { label: '切换到第 6 个标签页', defaults: ['Command+6'] },
  'tab-7': { label: '切换到第 7 个标签页', defaults: ['Command+7'] },
  'tab-8': { label: '切换到第 8 个标签页', defaults: ['Command+8'] },
  'last-tab': { label: '切换到最后一个标签页', defaults: ['Command+9'] },
  'extra-large-icons': { label: '超大图标视图', defaults: ['Control+Shift+1'] },
  icons: { label: '大图标视图', defaults: ['Control+Shift+2'] },
  'medium-icons': { label: '中图标视图', defaults: ['Control+Shift+3'] },
  'small-icons': { label: '小图标视图', defaults: ['Control+Shift+4'] },
  list: { label: '列表视图', defaults: ['Control+Shift+5'] },
  details: { label: '详细信息视图', defaults: ['Control+Shift+6'] },
  tiles: { label: '平铺视图', defaults: ['Control+Shift+7'] },
  content: { label: '内容视图', defaults: ['Control+Shift+8'] },
  preview: { label: '预览窗格', defaults: ['Command+Shift+P'] },
  hidden: { label: '隐藏的项目', defaults: ['Command+Shift+.'] },
  'details-pane': { label: '详细信息窗格', defaults: ['Command+I', 'Control+I', 'Alt+Enter'] },
  refresh: { label: '刷新', defaults: ['F5', 'Control+R'] },
} as const;
export type ShortcutAction = keyof typeof shortcutActions;
export type OperationShortcuts = Partial<Record<ShortcutAction, string[]>>;
export const shortcutActionIDs = Object.keys(shortcutActions) as ShortcutAction[];
const modifiers = ['Command', 'Control', 'Alt', 'Shift'];
const keys = ['Space', 'Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Plus', '=', '-', ',', '.', '[', ']', ';', "'", '`', '\\', '/'];
// shortcut: macOS has no complete shortcut registry; extend these reservations when adding fixed application commands.
const reserved = new Set([
  'Command+,', 'Command+Q', 'Command+H', 'Command+Alt+H', 'Command+M', 'Command+Shift+W', 'Command+Control+F',
  'Command+Shift+C', 'Command+Shift+H', 'Command+Shift+D', 'Command+Shift+O', 'Command+Alt+L', 'Command+Alt+S',
  'Command+Space', 'Command+Alt+Space', 'Control+Space', 'Control+Shift+Space', 'Command+Tab', 'Command+Shift+Tab',
  'Command+Alt+Escape', 'Control+Up', 'Control+Down', 'Control+Left', 'Control+Right',
  'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5',
  'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
]);

export function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 96) return null;
  if (!value) return '';
  const parts = value.split('+');
  let key = parts.pop()!;
  if (new Set(parts).size !== parts.length || !parts.every(part => modifiers.includes(part))) return null;
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key) && !keys.includes(key)) return null;
  if (key === '=' && parts.includes('Shift')) key = 'Plus';
  return [...modifiers.filter(part => parts.includes(part) && !(key === 'Plus' && part === 'Shift')), key].join('+');
}

export function validWakeShortcut(value: unknown): value is string {
  const normalized = normalizeShortcut(value);
  if (normalized === null) return false;
  return !normalized || normalized.split('+').slice(0, -1).some(part => part !== 'Shift') || /^F\d+$/.test(normalized.replace(/^Shift\+/, ''));
}

export function shortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  const code = event.code;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^(?:Digit|Numpad)[0-9]$/.test(code) ? code.slice(-1) : ({
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Equal: '=', NumpadAdd: 'Plus',
    Minus: '-', NumpadSubtract: '-', Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
    Quote: "'", Backquote: '`', Backslash: '\\', Slash: '/', NumpadEnter: 'Enter',
  } as Record<string, string>)[code] || code || ({ ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' } as Record<string, string>)[event.key] || (keys.includes(event.key) ? event.key : event.key.toUpperCase());
  return normalizeShortcut([...event.metaKey ? ['Command'] : [], ...event.ctrlKey ? ['Control'] : [], ...event.altKey ? ['Alt'] : [], ...event.shiftKey ? ['Shift'] : [], key].join('+'));
}

export function bindingsFor(action: ShortcutAction, overrides: OperationShortcuts): readonly string[] {
  return overrides[action] ?? shortcutActions[action].defaults;
}

export function formatShortcut(value: string): string {
  if (!value) return '';
  const parts = value.split('+');
  const key = parts.pop()!;
  const prefix = [['Control', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['Command', '⌘']].filter(([modifier]) => parts.includes(modifier)).map(([, symbol]) => symbol).join('');
  const display = ({ Enter: 'Return', Up: '↑', Down: '↓', Left: '←', Right: '→', Delete: '⌦', Plus: '+' } as Record<string, string>)[key] || (key === 'Backspace' && parts.includes('Command') ? '⌫' : key);
  return prefix + display;
}

export function validateOperationShortcuts(value: unknown, wake = ''): OperationShortcuts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(tr('无效的操作快捷键设置。'));
  const result: OperationShortcuts = {};
  for (const [id, input] of Object.entries(value)) {
    if (!Object.hasOwn(shortcutActions, id) || !Array.isArray(input) || input.length > 8) throw new Error(tr('无效的操作快捷键设置。'));
    const normalized = input.map(normalizeShortcut);
    if (normalized.some(key => !key) || new Set(normalized).size !== normalized.length) throw new Error(tr('无效的操作快捷键设置。'));
    for (const key of normalized as string[]) {
      const parts = key.split('+'); const base = parts.pop()!;
      if (!parts.some(part => part !== 'Shift') && !/^(?:F\d+|Enter|Space|Backspace|Delete)$/.test(base)) throw new Error(tr('请使用修饰键组合、功能键或 Return、Space、Backspace、Delete。'));
    }
    const action = id as ShortcutAction;
    if (JSON.stringify(normalized) !== JSON.stringify(shortcutActions[action].defaults)) result[action] = normalized as string[];
  }
  const used = new Map<string, ShortcutAction>();
  for (const action of shortcutActionIDs) for (const key of bindingsFor(action, result)) {
    if (reserved.has(key)) throw new Error(tr('“{0}”是应用或系统保留组合。', formatShortcut(key)));
    if (key === normalizeShortcut(wake)) throw new Error(tr('“{0}”与唤醒快捷键冲突。', formatShortcut(key)));
    const other = used.get(key);
    if (other) throw new Error(tr('“{0}”与“{1}”使用相同快捷键：{2}。', tr(shortcutActions[action].label), tr(shortcutActions[other].label), formatShortcut(key)));
    used.set(key, action);
  }
  return result;
}

export function validateWakeBinding(value: unknown, overrides: OperationShortcuts): string {
  if (!validWakeShortcut(value)) throw new Error(tr('请使用修饰键组合或 F1–F24 功能键。'));
  const normalized = normalizeShortcut(value)!;
  if (reserved.has(normalized)) throw new Error(tr('“{0}”是应用或系统保留组合。', formatShortcut(normalized)));
  validateOperationShortcuts(overrides, normalized);
  return normalized;
}

export function migrateOperationShortcuts(value: unknown, wake = ''): OperationShortcuts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(tr('无效的操作快捷键设置。'));
  // Check explicit bindings first; new defaults must yield to existing user choices.
  const disabled = Object.fromEntries(shortcutActionIDs.map(id => [id, []]));
  validateOperationShortcuts({ ...disabled, ...value }, wake);
  const result: OperationShortcuts = {};
  for (const [id, keys] of Object.entries(value)) result[id as ShortcutAction] = (keys as string[]).map(key => normalizeShortcut(key)!);
  const used = new Set([normalizeShortcut(wake), ...Object.values(result).flat()]);
  for (const action of shortcutActionIDs) {
    if (Object.hasOwn(result, action)) continue;
    const defaults = shortcutActions[action].defaults;
    if (defaults.some(key => used.has(key))) result[action] = defaults.filter(key => !used.has(key));
  }
  return validateOperationShortcuts(result, wake);
}
