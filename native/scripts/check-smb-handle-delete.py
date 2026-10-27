#!/usr/bin/env python3
"""Real client wire regression against a controlled loopback SMB fixture.
No mounts, credentials from keychain, existing shares or NAS files. The fixture
models handle identity explicitly; it does NOT certify any NAS server's backend.
Requires the same dedicated test venv as check-smb-server-copy.py.
"""
import ctypes
import importlib.util
import os
from pathlib import Path
import platform
import re
import socket
import struct
import subprocess
import tempfile
import time

from impacket import smbserver, smb3structs as smb2
from impacket.nt_errors import (STATUS_SUCCESS, STATUS_ACCESS_DENIED, STATUS_NOT_SUPPORTED,
                               STATUS_DIRECTORY_NOT_EMPTY)

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('copy_fixture', ROOT / 'scripts/check-smb-server-copy.py')
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)


class DeleteFixture(wire.Fixture):
    def __init__(self, source, destination):
        super().__init__(source, destination)
        self.delete_mode = 'success'
        self.opens, self.dispositions, self.closed = [], [], []
        self.query_count = {}
        original_create = self.server.hookSmb2Command(smb2.SMB2_CREATE, None)
        original_query = self.server.hookSmb2Command(smb2.SMB2_QUERY_INFO, None)
        original_directory = self.server.hookSmb2Command(smb2.SMB2_QUERY_DIRECTORY, None)
        original_set = self.server.hookSmb2Command(smb2.SMB2_SET_INFO, None)
        original_close = self.server.hookSmb2Command(smb2.SMB2_CLOSE, None)

        def create(conn, server, packet):
            req = smb2.SMB2Create(packet['Data'])
            result = original_create(conn, server, packet)
            if result[2] == STATUS_SUCCESS:
                entry = self.entry(conn, {'FileID': result[0][0]['FileID']})
                entry['FixtureIdentity'] = os.stat(entry['FileName']).st_ino
                self.opens.append((entry['FileName'], req['DesiredAccess'], req['ShareAccess'],
                                   req['CreateDisposition'], req['CreateOptions']))
            return result

        def query(conn, server, packet):
            req = smb2.SMB2QueryInfo(packet['Data'])
            result = original_query(conn, server, packet)
            key = req['FileID'].getData()
            self.query_count[key] = self.query_count.get(key, 0) + 1
            entry = self.entry(conn, req)
            # Return the original handle's information, then replace its old name
            # before the client can submit disposition. No sleep-based race test.
            if (self.delete_mode == 'replace-after-check' and result[2] == STATUS_SUCCESS
                    and self.query_count[key] == 2 and Path(entry['FileName']).name == 'late.txt'):
                old = Path(entry['FileName']); retained = old.with_name('held-original')
                old.rename(retained); old.write_bytes(b'new occupant')
                entry['FileName'] = str(retained)
            return result

        def directory(conn, server, packet):
            req = smb2.SMB2QueryDirectory(packet['Data'])
            result = original_directory(conn, server, packet)
            if result[2] == STATUS_SUCCESS and req['FileInformationClass'] == 0x26:
                data = bytearray(result[0][0]['Buffer']); offset = 0
                parent = Path(self.entry(conn, req)['FileName'])
                while offset < len(data):
                    next_entry, = struct.unpack_from('<I', data, offset)
                    name_length, = struct.unpack_from('<I', data, offset + 60)
                    name = bytes(data[offset+80:offset+80+name_length]).decode('utf-16le')
                    struct.pack_into('<Q', data, offset + 72, (parent / name).lstat().st_ino)
                    if not next_entry: break
                    offset += next_entry
                result[0][0]['Buffer'] = bytes(data)
            return result

        def set_info(conn, server, packet):
            req = smb2.SMB2SetInfo(packet['Data'])
            if req['FileInfoClass'] != smb2.SMB2_FILE_DISPOSITION_INFO:
                return original_set(conn, server, packet)
            assert packet['Flags'] & smb2.SMB2_FLAGS_SIGNED
            assert bytes(req['Buffer']) == b'\x01'
            entry = self.entry(conn, req)
            self.dispositions.append((req['FileID'].getData(), entry['FixtureIdentity']))
            if self.delete_mode == 'unsupported': return [smb2.SMB2Error()], None, STATUS_NOT_SUPPORTED
            if self.delete_mode == 'denied': return [smb2.SMB2Error()], None, STATUS_ACCESS_DENIED
            if os.path.isdir(entry['FileName']) and os.listdir(entry['FileName']):
                return [smb2.SMB2Error()], None, STATUS_DIRECTORY_NOT_EMPTY
            entry['DeleteOnClose'] = True
            if self.delete_mode == 'disconnect-disposition':
                wire.LOCAL.socket.shutdown(socket.SHUT_RDWR)
                raise ConnectionResetError('fixture disconnect after accepting delete disposition')
            if self.delete_mode == 'timeout-disposition':
                time.sleep(3)
            return [smb2.SMB2SetInfo_Response()], None, STATUS_SUCCESS

        def close(conn, server, packet):
            req = smb2.SMB2Close(packet['Data'])
            entry = self.entry(conn, req)
            if entry.get('DeleteOnClose'):
                name = Path(entry['FileName'])
                # Never use impacket's recursive rmtree for a directory close.
                assert name.stat().st_ino == entry['FixtureIdentity']
                entry['DeleteOnClose'] = False
                if name.is_dir(): name.rmdir()
                else: name.unlink()
                self.closed.append(req['FileID'].getData())
                fd = entry['FileHandle']
                if fd not in [smbserver.VOID_FILE_DESCRIPTOR, smbserver.PIPE_FILE_DESCRIPTOR]: os.close(fd)
                data = server.getConnectionData(conn)
                del data['OpenedFiles'][req['FileID'].getData()]
                server.setConnectionData(conn, data)
                if self.delete_mode == 'disconnect-close':
                    wire.LOCAL.socket.shutdown(socket.SHUT_RDWR)
                    raise ConnectionResetError('fixture disconnect after actual deletion')
                return [smb2.SMB2Close_Response()], None, STATUS_SUCCESS
            return original_close(conn, server, packet)

        self.server.hookSmb2Command(smb2.SMB2_CREATE, create)
        self.server.hookSmb2Command(smb2.SMB2_QUERY_INFO, query)
        self.server.hookSmb2Command(smb2.SMB2_QUERY_DIRECTORY, directory)
        self.server.hookSmb2Command(smb2.SMB2_SET_INFO, set_info)
        self.server.hookSmb2Command(smb2.SMB2_CLOSE, close)


def main():
    count = 0
    def expect(value, message):
        nonlocal count
        if not value: raise AssertionError(message)
        count += 1
        print('PASS', message, flush=True)

    with tempfile.TemporaryDirectory(prefix='explorer-smb-delete-wire-') as temporary:
        folder = Path(temporary); library = folder / 'transport.dylib'
        vendor = ROOT / 'Vendor/libsmb2'
        sources = re.findall(r'"(lib/[^" ]+\.c)"', (ROOT / 'Package.swift').read_text())
        transport = folder / 'transport.c'
        transport.write_text((ROOT / 'Sources/SMBTransport/SMBTransport.c').read_text() + '''
int mx_fixture_times(const char *path, int64_t *times) { struct stat s; if (stat(path,&s)) return -1; times[0]=s.st_birthtimespec.tv_sec; times[1]=s.st_birthtimespec.tv_nsec; times[2]=s.st_mtimespec.tv_sec; times[3]=s.st_mtimespec.tv_nsec; return 0; }
''')
        subprocess.run(['xcrun','clang','-dynamiclib','-O1','-target',f'{platform.machine()}-apple-macos13.0',
                        '-DMX_SMB_TIMEOUT_SECONDS=2','-DHAVE_CONFIG_H','-D_FILE_OFFSET_BITS=64','-D_U_=__attribute__((unused))',
                        '-I',str(vendor/'include'),'-I',str(vendor/'include/smb2'),'-I',str(vendor/'lib'),
                        '-I',str(ROOT/'Sources/SMBTransport/include'),*[str(vendor/x) for x in sources],str(transport),'-o',str(library)],
                       check=True,capture_output=True)
        lib = ctypes.CDLL(str(library)); wire.PRECISE_TIMES = lib.mx_fixture_times
        wire.PRECISE_TIMES.argtypes = [ctypes.c_char_p,ctypes.POINTER(ctypes.c_int64)]
        lib.mx_smb_connect.argtypes = [ctypes.c_char_p]*6+[ctypes.c_int,ctypes.POINTER(ctypes.c_int)]
        lib.mx_smb_connect.restype = ctypes.c_void_p
        lib.mx_smb_destroy.argtypes = [ctypes.c_void_p]
        Cancel = ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_void_p)
        class Stamp(ctypes.Structure):
            _fields_ = [('inode',ctypes.c_uint64),('size',ctypes.c_int64),('birth_seconds',ctypes.c_int64),
                        ('birth_nanos',ctypes.c_int64),('modified_seconds',ctypes.c_int64),('modified_nanos',ctypes.c_int64),('type',ctypes.c_uint32)]
        lib.mx_smb_delete_begin.argtypes = [ctypes.c_void_p,ctypes.c_char_p,ctypes.c_char_p,Cancel,ctypes.c_void_p,ctypes.POINTER(ctypes.c_int)]
        lib.mx_smb_delete_begin.restype = ctypes.c_void_p
        lib.mx_smb_delete_bind.argtypes = [ctypes.c_void_p,ctypes.c_char_p,ctypes.POINTER(Stamp),ctypes.POINTER(ctypes.c_int)]
        lib.mx_smb_delete_commit.argtypes = [ctypes.c_void_p,ctypes.c_char_p,ctypes.POINTER(ctypes.c_int)]
        lib.mx_smb_delete_end.argtypes = [ctypes.c_void_p]
        source, destination = folder/'SRC', folder/'DST';source.mkdir();destination.mkdir()
        fixture = DeleteFixture(source,destination)
        endpoint=f'127.0.0.1:{fixture.server.server_address[1]}'.encode()
        def stamp(path):
            st=path.lstat(); times=(ctypes.c_int64*4)();assert wire.PRECISE_TIMES(os.fsencode(path),times)==0
            return Stamp(st.st_ino,st.st_size,*times,st.st_mode & 0o170000)
        class Operation:
            def __init__(self, name, mode='success'):
                fixture.delete_mode=mode;fixture.opens.clear();fixture.dispositions.clear();fixture.closed.clear();fixture.query_count.clear()
                self.cancelled=False; self.cancel=Cancel(lambda _:self.cancelled);self.code=ctypes.c_int()
                self.session=lib.mx_smb_connect(endpoint,b'SRC',b'SRC',b'fixture',b'',b'fixture-password',0,ctypes.byref(self.code))
                assert self.session, self.code.value
                self.group=lib.mx_smb_delete_begin(self.session,os.fsencode(source),name.encode(),self.cancel,None,ctypes.byref(self.code))
                assert self.group,self.code.value
            def bind(self,path,expected=None):
                value=expected or stamp(source/path)
                return lib.mx_smb_delete_bind(self.group,path.encode(),ctypes.byref(value),ctypes.byref(self.code))
            def commit(self,path):return lib.mx_smb_delete_commit(self.group,path.encode(),ctypes.byref(self.code))
            def close(self):lib.mx_smb_delete_end(self.group);lib.mx_smb_destroy(self.session)
        try:
            regular=source/'中文 空格.txt';regular.write_bytes(b'keep until commit')
            op=Operation(regular.name);expect(op.bind(regular.name)==0,'bind existing file without mutation')
            expect(regular.exists() and not fixture.dispositions,'binding and cleanup cannot arm delete-on-close')
            deletes=[o for o in fixture.opens if o[1] & 0x10000]
            expect(len(deletes)==1 and deletes[0][2]==1 and deletes[0][3]==1 and not deletes[0][4]&0x1000,
                   'DELETE handle denies write/delete sharing, opens existing and does not set CREATE delete-on-close')
            opens=len(fixture.opens)
            expect(op.commit(regular.name)==0 and not regular.exists(),'SET_INFO and CLOSE acknowledge deletion')
            expect(len(fixture.opens)==opens and len(fixture.dispositions)==1 and len(fixture.closed)==1
                   and fixture.dispositions[0][0]==fixture.closed[0] and fixture.query_count[fixture.closed[0]]>=3,
                   'commit uses the same opened FileId without reopening the name')
            expect(op.commit(regular.name)==2,'consumed handle cannot be committed twice');op.close()
            for mode in ['unsupported','denied']:
                f=source/mode;f.write_bytes(b'keep');op=Operation(mode,mode);assert op.bind(mode)==0
                expect(op.commit(mode)==2 and op.code.value!=0,'server '+mode+' fails closed without a fallback')
                op.close();expect(f.read_bytes()==b'keep','failed '+mode+' does not delete during cleanup')
            late=source/'late.txt';late.write_bytes(b'original');op=Operation('late.txt','replace-after-check');assert op.bind('late.txt')==0
            expect(op.commit('late.txt')==0 and late.read_bytes()==b'new occupant' and not (source/'held-original').exists(),
                   'deterministic last-check replacement preserves new occupant and deletes only bound original in the handle-aware fixture');op.close()
            changed=source/'changed';changed.write_bytes(b'first');oldstamp=stamp(changed);changed.rename(source/'changed-old');changed.write_bytes(b'new')
            op=Operation('changed');expect(op.bind('changed',oldstamp)==2 and not fixture.dispositions,'identity mismatch aborts before disposition');op.close()
            f=source/'cancel';f.write_bytes(b'keep');op=Operation('cancel');assert op.bind('cancel')==0;op.cancelled=True
            expect(op.commit('cancel')==2 and not fixture.dispositions,'cancellation before disposition leaves source untouched');op.close()
            f=source/'abandon';f.write_bytes(b'keep');op=Operation('abandon');assert op.bind('abandon')==0;op.close()
            expect(f.exists() and not fixture.dispositions,'abandoned confirmed group closes non-deleting handles')
            for mode in ['disconnect-disposition','timeout-disposition','disconnect-close']:
                f=source/mode;f.write_bytes(b'keep');op=Operation(mode,mode);assert op.bind(mode)==0
                expect(op.commit(mode)==3,'lost '+mode+' result is uncertain, never a safe failure')
                before=len(fixture.dispositions)
                expect(op.commit(mode)==2 and len(fixture.dispositions)==before,'broken operation never reconnects or retries by name');op.close()
            tree=source/'tree';tree.mkdir();(tree/'child').write_bytes(b'confirmed');op=Operation('tree');assert op.bind('tree')==0 and op.bind('tree/child')==0
            expect(op.commit('tree')==2,'parent cannot be committed ahead of a bound child');op.close()
            op=Operation('tree');assert op.bind('tree')==0 and op.bind('tree/child')==0
            (tree/'new').write_bytes(b'preserve')
            expect(op.commit('tree/child')==2 and (tree/'new').read_bytes()==b'preserve' and (tree/'child').exists() and not fixture.dispositions,
                   'remote manifest catches an unconfirmed child before any delete disposition');op.close()
            tree2=source/'tree2';tree2.mkdir();(tree2/'child').write_bytes(b'x');op=Operation('tree2');assert op.bind('tree2')==0 and op.bind('tree2/child')==0
            child_result = op.commit('tree2/child'); child_code = op.code.value
            parent_result = op.commit('tree2'); parent_code = op.code.value
            expect(child_result==0 and parent_result==0 and not tree2.exists(),f'postorder closes handle-bound children and empty parent ({child_result}/{child_code}, {parent_result}/{parent_code})');op.close()
            link=source/'link';link.symlink_to(source/'cancel');op=Operation('link')
            expected=Stamp(type=0o120000)
            expect(op.bind('link',expected)==2 and not fixture.dispositions,'symlinks are rejected without traversal');op.close()
            f=source/'outside';f.write_bytes(b'outside');op=Operation('cancel')
            expect(op.bind('outside')==2 and op.bind('../outside',stamp(f))==2,'binding cannot escape the confirmed root or use dot components');op.close()
            expect(f.read_bytes()==b'outside','out-of-scope object remains unchanged')
        finally:fixture.stop()
    print(f'SMB handle deletion wire checks: {count} passed. NAS backend atomicity is not certified.')

if __name__=='__main__':main()
