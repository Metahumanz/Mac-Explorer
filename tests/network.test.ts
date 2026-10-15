import test from 'node:test';
import assert from 'node:assert/strict';
import { networkAddress } from '../electron/network';

test('SMB addresses preserve shares, Unicode filenames, IPv6 and alternate ports', () => {
  assert.equal(networkAddress(' smb://nas.local/团队 文件 '), 'smb://nas.local/%E5%9B%A2%E9%98%9F%20%E6%96%87%E4%BB%B6');
  assert.equal(networkAddress('smb://192.168.1.2'), 'smb://192.168.1.2');
  assert.equal(networkAddress('smb://[::1]:1445/share'), 'smb://[::1]:1445/share');
});

test('SMB boundary rejects other protocols, credentials, options and malformed inputs', () => {
  for (const value of [null, [], 12, '', 'smb://', 'smb:server/share', 'file:///tmp', 'https://nas/share', 'smb://user:secret@nas/share', 'smb://user@nas/share', 'smb://nas/share?option=1', 'smb://nas/share#fragment', 'smb://nas/\0share', 'smb://nas/\nshare', 'smb://nas\\share', 'smb://nas:99999/share', 'smb://' + 'x'.repeat(2048)]) {
    assert.throws(() => networkAddress(value), /SMB/);
  }
});
