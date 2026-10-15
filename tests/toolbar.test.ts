import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultToolbar, normalizeToolbar } from '../shared/toolbar';

test('toolbar preferences retain order, deduplicate and ignore unknown actions', () => {
  assert.deepEqual(normalizeToolbar(['airdrop', 'copy', 'airdrop', null, {}, 'unknown', 'terminal']), ['airdrop', 'copy', 'terminal']);
  assert.deepEqual(normalizeToolbar([]), []);
});
test('invalid toolbar preferences restore an independent default list', () => {
  for (const value of [null, {}, 'copy', 123]) assert.deepEqual(normalizeToolbar(value), defaultToolbar);
  const copy = normalizeToolbar(null); copy.reverse();
  assert.deepEqual(defaultToolbar, ['cut', 'copy', 'paste', 'rename', 'share', 'trash']);
});
