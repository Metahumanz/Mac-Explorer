import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingsFor, formatShortcut, normalizeShortcut, shortcutFromEvent, validateOperationShortcuts, validateWakeBinding, validWakeShortcut } from '../shared/shortcuts';

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
