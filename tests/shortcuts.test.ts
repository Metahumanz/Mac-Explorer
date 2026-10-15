import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingsFor, formatShortcut, migrateOperationShortcuts, normalizeShortcut, shortcutActions, shortcutActionIDs, shortcutFromEvent, validateOperationShortcuts, validateWakeBinding, validWakeShortcut } from '../shared/shortcuts';

test('normalizes modifier order and rejects malformed shortcuts', () => {
  assert.equal(normalizeShortcut('Shift+Alt+Command+K'), 'Command+Alt+Shift+K');
  assert.equal(normalizeShortcut('Command+Shift+='), 'Command+Plus');
  assert.equal(normalizeShortcut('Command+Shift+Plus'), 'Command+Plus');
  assert.equal(normalizeShortcut('Command+='), 'Command+=');
  for (const input of [null, 12, 'Command+Command+K', 'Meta+K', 'Command+k', 'Command+', 'Command+\0']) assert.equal(normalizeShortcut(input), null);
  assert.equal(validWakeShortcut('K'), false);
  assert.equal(validWakeShortcut('F12'), true);
  assert.equal(formatShortcut('Command+Alt+V'), '⌥⌘V');
  assert.equal(formatShortcut('Command+Backspace'), '⌘⌫');
  assert.equal(shortcutFromEvent({ code: 'Period', key: '>', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }), 'Command+Shift+.');
  assert.equal(shortcutFromEvent({ code: 'Equal', key: '+', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }), 'Command+Plus');
});
test('operation mappings preserve aliases by default and can replace, disable and reset them', () => {
  assert.deepEqual(validateOperationShortcuts({}), {});
  assert.deepEqual(bindingsFor('rename', {}), ['Enter', 'F2']);
  const overrides = validateOperationShortcuts({ rename: ['Alt+Command+K'], copy: [] });
  assert.deepEqual(overrides, { rename: ['Command+Alt+K'], copy: [] });
  assert.deepEqual(bindingsFor('rename', overrides), ['Command+Alt+K']);
  assert.deepEqual(bindingsFor('copy', overrides), []);
  assert.deepEqual(validateOperationShortcuts({ rename: ['Enter', 'F2'] }), {});
});
test('rejects conflicts with other actions, compatibility aliases, wake and reserved shortcuts', () => {
  assert.throws(() => validateOperationShortcuts({ rename: ['Control+C'] }), /复制/);
  assert.throws(() => validateOperationShortcuts({ rename: ['Command+Plus'], copy: ['Command+Shift+='] }), /相同快捷键/);
  assert.throws(() => validateOperationShortcuts({ rename: ['Command+Alt+K'] }, 'Alt+Command+K'), /唤醒/);
  assert.throws(() => validateWakeBinding('Command+C', {}), /唤醒/);
  for (const key of ['Command+,', 'Command+Q', 'Command+Space', 'Control+Space', 'Command+Shift+3', 'Command+Shift+W']) {
    assert.throws(() => validateOperationShortcuts({ rename: [key] }), /保留/);
    assert.throws(() => validateWakeBinding(key, {}), /保留/);
  }
  assert.deepEqual(validateOperationShortcuts({ copy: [], rename: ['Command+C'] }), { copy: [], rename: ['Command+C'] });
});
test('rejects invalid IPC values instead of dropping or partially accepting them', () => {
  for (const value of [null, [], { unknown: ['Command+K'] }, { copy: 'Command+K' }, { copy: [''] }, { copy: ['Command+K', 'Command+K'] }, { copy: ['K'] }, { copy: Array(9).fill('F2') }]) assert.throws(() => validateOperationShortcuts(value));
});

test('numbered tabs and eight layouts have distinct, non-reserved defaults', () => {
  assert.deepEqual(validateOperationShortcuts({}), {});
  for (let number = 1; number <= 8; number++) assert.deepEqual(bindingsFor(`tab-${number}` as keyof typeof shortcutActions, {}), [`Command+${number}`]);
  assert.deepEqual(bindingsFor('last-tab', {}), ['Command+9']);
  const layouts = ['extra-large-icons', 'icons', 'medium-icons', 'small-icons', 'list', 'details', 'tiles', 'content'] as const;
  layouts.forEach((action, index) => {
    assert.deepEqual(bindingsFor(action, {}), [`Control+Shift+${index + 1}`]);
    assert.equal(shortcutFromEvent({ code: `Digit${index + 1}`, key: '!@#$%^&*'[index], metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }), bindingsFor(action, {})[0]);
  });
});

test('legacy custom bindings and wake take priority over new defaults without resetting other actions', () => {
  assert.deepEqual(migrateOperationShortcuts({}), {});
  const legacy = { rename: ['Alt+Command+R'], copy: [], icons: ['Command+3'], details: ['Control+Shift+5'], refresh: ['Command+8'] };
  const migrated = migrateOperationShortcuts(legacy, 'Command+9');
  assert.deepEqual(migrated, { ...legacy, rename: ['Command+Alt+R'], 'tab-3': [], 'tab-8': [], 'last-tab': [], list: [] });
  assert.deepEqual(validateOperationShortcuts(migrated, 'Command+9'), migrated);
  assert.deepEqual(migrateOperationShortcuts(migrated, 'Command+9'), migrated);
  assert.deepEqual(legacy.rename, ['Alt+Command+R']);
  assert.deepEqual(migrateOperationShortcuts({ icons: ['Command+1'], details: ['Command+2'] }), { icons: ['Command+1'], details: ['Command+2'], 'tab-1': [], 'tab-2': [] });
  assert.throws(() => validateOperationShortcuts({ rename: ['Command+3'] }), /相同快捷键/);
  for (const value of [null, [], { unknown: [] }, { rename: ['Command+Shift+3'] }, { rename: ['K'] }, { rename: ['Command+K'], copy: ['Command+K'] }]) assert.throws(() => migrateOperationShortcuts(value));
  assert.equal(shortcutActionIDs.length, 42);
});
