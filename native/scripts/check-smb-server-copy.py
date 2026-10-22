#!/usr/bin/env python3
"""Exercise the real C transport against an independent loopback SMB2 fixture.
Requires Python 3.11+ and impacket==0.13.0 in a dedicated venv. Never mounts a share,
uses NAS credentials, modifies system SMB settings, or accesses existing files.
"""
import configparser
import ctypes
import logging
import os
from pathlib import Path
import platform
import re
import socket
import struct
import sys
import subprocess
import tempfile
import threading

from impacket import ntlm, smbserver, smb3structs as smb2
from impacket.nt_errors import STATUS_SUCCESS, STATUS_NOT_SUPPORTED, STATUS_INVALID_PARAMETER

ROOT = Path(__file__).resolve().parents[1]
logging.disable(logging.CRITICAL)
LOCAL = threading.local()
PRECISE_TIMES = None


def exact_file_info(path, filename, level):
    result, status = ORIGINAL_INFO(path, filename, level)
    if status == STATUS_SUCCESS and level == smb2.SMB2_FILE_ALL_INFO:
        info = os.stat(os.path.join(path, filename))
        basic = result['BasicInformation']
        epoch = 116444736000000000
        times = (ctypes.c_int64 * 4)()
        assert PRECISE_TIMES(os.fsencode(os.path.join(path, filename)), times) == 0
        basic['CreationTime'] = epoch + times[0] * 10000000 + times[1] // 100
        basic['LastWriteTime'] = epoch + times[2] * 10000000 + times[3] // 100
        basic['LastAccessTime'] = epoch + info.st_atime_ns // 100
        basic['ChangeTime'] = epoch + info.st_ctime_ns // 100
        if os.path.islink(os.path.join(path, filename)):
            basic['FileAttributes'] |= smb2.FILE_ATTRIBUTE_REPARSE_POINT
    return result, status


ORIGINAL_INFO = smbserver.queryPathInformation
smbserver.queryPathInformation = exact_file_info


class Handler(smbserver.SMBSERVERHandler):
    def handle(self):
        LOCAL.socket = self.request
        super().handle()


class Fixture:
    def __init__(self, source, destination):
        config = configparser.ConfigParser()
        config['global'] = dict(server_name='EXPLORER-FIXTURE', server_os='Fixture',
                                server_domain='FIXTURE', log_file='', rpc_apis='no',
                                credentials_file='', challenge='AB' * 8, SMB2Support='yes')
        for name, folder in [('SRC', source), ('DST', destination)]:
            config[name] = {'comment': 'temporary fixture', 'read only': 'no', 'share type': '0', 'path': str(folder)}
        self.server = smbserver.SMBSERVER(('127.0.0.1', 0), handler_class=Handler, config_parser=config)
        self.server.daemon_threads = True
        self.server.processConfigFile()
        self.server.addCredential('fixture', 0, ntlm.compute_lmhash('fixture-password'), ntlm.compute_nthash('fixture-password'))
        self.source_root = source
        self.destination_root = destination
        self.mode = 'success'
        self.keys = {}
        self.chunks = []
        self.reads = self.writes = 0
        self.signed = 0
        self.requests = 0
        self.server.getIoctls()[0x00140078] = self.resume
        self.server.getIoctls()[0x001440F2] = self.copy
        for command in [smb2.SMB2_READ, smb2.SMB2_WRITE, smb2.SMB2_CREATE, smb2.SMB2_IOCTL, smb2.SMB2_QUERY_INFO]:
            original = self.server.hookSmb2Command(command, None)
            def observe(conn, server, packet, original=original, command=command):
                self.requests += 1
                self.signed += bool(packet['Flags'] & smb2.SMB2_FLAGS_SIGNED)
                self.reads += command == smb2.SMB2_READ
                self.writes += command == smb2.SMB2_WRITE
                return original(conn, server, packet)
            self.server.hookSmb2Command(command, observe)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def entry(self, conn, request):
        key = request['FileID'].getData() if hasattr(request['FileID'], 'getData') else request['FileID']
        return self.server.getConnectionData(conn)['OpenedFiles'][key]

    def resume(self, conn, server, request):
        if self.mode == 'resume-unsupported': return smb2.SMB2Error(), STATUS_NOT_SUPPORTED
        key = os.urandom(24)
        self.keys[key] = (conn, self.entry(conn, request))
        return key + b'\0' * 8, STATUS_SUCCESS

    def copy(self, conn, server, request):
        if self.mode == 'unsupported':
            return smb2.SMB2Error(), STATUS_NOT_SUPPORTED
        data = bytes(request['Buffer'])
        assert len(data) == 56 and struct.unpack_from('<II', data, 24) == (1, 0)
        source_conn, source = self.keys[data[:24]]
        assert source_conn == conn, 'Both tree connections must share one SMB session'
        target = self.entry(conn, request)
        assert Path(source['FileName']).is_relative_to(self.source_root)
        assert Path(target['FileName']).is_relative_to(self.destination_root)
        source_offset, destination_offset, length, reserved = struct.unpack_from('<QQII', data, 32)
        assert reserved == 0 and 0 < length <= 1024 * 1024
        if self.mode == 'limits' and length > 256 * 1024:
            response = smb2.SMB2Ioctl_Response()
            response['CtlCode'] = request['CtlCode']; response['FileID'] = request['FileID']
            response['InputOffset'] = 0; response['InputCount'] = 0
            response['OutputOffset'] = 0x70; response['OutputCount'] = 12; response['Flags'] = 0
            response['Buffer'] = struct.pack('<III', 1, 256 * 1024, 256 * 1024)
            return response, STATUS_INVALID_PARAMETER
        payload = os.pread(source['FileHandle'], length, source_offset)
        assert len(payload) == length
        assert os.pwrite(target['FileHandle'], payload, destination_offset) == length
        self.chunks.append((source_offset, destination_offset, length))
        if self.mode == 'delayed':
            import time
            time.sleep(3)
        if self.mode == 'disconnect':
            LOCAL.socket.shutdown(socket.SHUT_RDWR)
            raise ConnectionResetError('fixture disconnect after server-side write')
        if self.mode == 'invalid-count':
            return struct.pack('<III', 2, 0, length), STATUS_SUCCESS
        if self.mode == 'short-reply':
            return struct.pack('<I', 1), STATUS_SUCCESS
        return struct.pack('<III', 1, 0, length), STATUS_SUCCESS


def main():
    global PRECISE_TIMES
    checks = 0
    def expect(value, message):
        nonlocal checks
        if not value:
            raise AssertionError(message)
        checks += 1
    with tempfile.TemporaryDirectory(prefix='explorer-smb-wire-') as temporary:
        folder = Path(temporary)
        library = folder / 'libfixture-transport.dylib'
        vendor = ROOT / 'Vendor/libsmb2'
        sources = re.findall(r'"(lib/[^" ]+\.c)"', (ROOT / 'Package.swift').read_text())
        assert len(sources) > 40
        transport = folder / 'fixture-transport.c'
        text = (ROOT / 'Sources/SMBTransport/SMBTransport.c').read_text()
        text += '\nint mx_fixture_times(const char *path, int64_t *times) { struct stat s; if (stat(path, &s)) return -1; times[0]=s.st_birthtimespec.tv_sec; times[1]=s.st_birthtimespec.tv_nsec; times[2]=s.st_mtimespec.tv_sec; times[3]=s.st_mtimespec.tv_nsec; return 0; }\n'
        text += '\nint mx_fixture_socket_no_sigpipe(mx_smb_session *s) { int enabled = 0; socklen_t size = sizeof(enabled); return getsockopt(smb2_get_fd(s->smb), SOL_SOCKET, SO_NOSIGPIPE, &enabled, &size) == 0 && enabled == 1; }\nvoid mx_fixture_drop_socket(mx_smb_session *s) { shutdown(smb2_get_fd(s->smb), SHUT_RDWR); }\n'
        transport.write_text(text)
        subprocess.run(['xcrun', 'clang', '-dynamiclib', '-O1', '-target', f'{platform.machine()}-apple-macos13.0',
                        '-DMX_SMB_TIMEOUT_SECONDS=2', '-DHAVE_CONFIG_H', '-D_FILE_OFFSET_BITS=64', '-D_U_=__attribute__((unused))',
                        '-I', str(vendor / 'include'), '-I', str(vendor / 'include/smb2'), '-I', str(vendor / 'lib'),
                        '-I', str(ROOT / 'Sources/SMBTransport/include'),
                        *[str(vendor / name) for name in sources], str(transport),
                        '-o', str(library)], check=True, capture_output=True)
        lib = ctypes.CDLL(str(library))
        random_bytes = lib.smb2_random_bytes
        random_bytes.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        random_buffer = (ctypes.c_uint8 * 32)()
        expect(random_bytes(random_buffer, len(random_buffer)) == 0, 'The compiled SMB client uses a strong platform random source')
        PRECISE_TIMES = lib.mx_fixture_times
        PRECISE_TIMES.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int64)]
        lib.mx_smb_connect.argtypes = [ctypes.c_char_p] * 6 + [ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        lib.mx_smb_connect.restype = ctypes.c_void_p
        lib.mx_smb_destroy.argtypes = [ctypes.c_void_p]
        lib.mx_fixture_socket_no_sigpipe.argtypes = [ctypes.c_void_p]
        lib.mx_fixture_drop_socket.argtypes = [ctypes.c_void_p]
        class Metrics(ctypes.Structure):
            _fields_ = [('binding_seconds', ctypes.c_double), ('copychunk_seconds', ctypes.c_double),
                        ('closing_seconds', ctypes.c_double), ('request_count', ctypes.c_uint64),
                        ('acknowledged_bytes', ctypes.c_uint64)]
        lib.mx_smb_copy_metrics.argtypes = [ctypes.c_void_p, ctypes.POINTER(Metrics)]
        last_metrics = Metrics()
        Cancel = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
        Progress = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint64)
        lib.mx_smb_copy.argtypes = [ctypes.c_void_p] + [ctypes.c_char_p] * 4 + [ctypes.c_int] * 2 + [Cancel, Progress, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        source, destination = folder / 'SRC', folder / 'DST'
        source.mkdir(); destination.mkdir()
        fixture = Fixture(source, destination)
        try:
            endpoint = f'127.0.0.1:{fixture.server.server_address[1]}'.encode()
            def connect(password=b'fixture-password', encrypted=0):
                error = ctypes.c_int()
                session = lib.mx_smb_connect(endpoint, b'SRC', b'DST', b'fixture', b'', password, encrypted, ctypes.byref(error))
                return session, error.value
            def transfer(name, mode='success', cancel_after=None, wrong_target=False):
                fixture.mode = mode; fixture.chunks.clear()
                content = (bytes(range(256)) * 10000) + b'end'
                src, dst = source / name, destination / name
                src.parent.mkdir(parents=True, exist_ok=True); dst.parent.mkdir(parents=True, exist_ok=True)
                src.write_bytes(content); dst.touch()
                held_target = dst
                if wrong_target:
                    held_target = destination / (name + '-other'); held_target.touch()
                session, error = connect()
                expect(bool(session), f'Authenticated signed connection and second tree connect succeed (errno {error})')
                from_fd = os.open(src, os.O_RDONLY); to_fd = os.open(held_target, os.O_RDWR)
                progress = []
                @Cancel
                def cancelled(_):
                    return bool(cancel_after is not None and sum(done > 0 for done, _ in progress) >= cancel_after)
                @Progress
                def update(_, done, total):
                    progress.append((done, total))
                try:
                    code = ctypes.c_int()
                    result = lib.mx_smb_copy(session, os.fsencode(source), os.fsencode(destination), name.encode(), name.encode(),
                                             from_fd, to_fd, cancelled, update, None, ctypes.byref(code))
                    lib.mx_smb_copy_metrics(session, ctypes.byref(last_metrics))
                    return result, code.value, src, dst, content, progress
                finally:
                    os.close(from_fd); os.close(to_fd); lib.mx_smb_destroy(session)

            result, error, src, dst, content, progress = transfer('中文 file.txt')
            expect(result == 0, f'Cross-share server-side copy succeeds (result {result}, errno {error}, requests {fixture.requests}, keys {len(fixture.keys)})')
            expect(dst.read_bytes() == content and src.read_bytes() == content, 'Only server-side copy writes the complete file')
            expect(len(fixture.chunks) == 3 and progress[-1] == (len(content), len(content)), 'One MiB chunks report acknowledged cumulative progress')
            expect(progress[0] == (0, len(content)), 'Rate baseline starts after binding and before the first data request')
            expect(last_metrics.acknowledged_bytes == len(content) and last_metrics.request_count >= 3
                   and last_metrics.copychunk_seconds > 0 and last_metrics.binding_seconds > 0
                   and last_metrics.closing_seconds > 0, 'Protocol diagnostics separate binding, COPYCHUNK, close and acknowledged bytes')
            expect(fixture.reads == 0 and fixture.writes == 0, 'No SMB READ/WRITE file data travels through the client')
            expect(fixture.signed == fixture.requests, 'All observed authenticated SMB requests are signed')
            result, error, _, dst, content, progress = transfer('nested/deep/file.txt')
            expect(result == 0 and dst.read_bytes() == content, 'Nested ancestor locks and identity checks permit a valid cross-share file')
            result, _, _, dst, content, progress = transfer('limits', mode='limits')
            expect(result == 0 and dst.read_bytes() == content and all(chunk[2] <= 256 * 1024 for chunk in fixture.chunks), 'Advertised server limits reduce the request size once without duplicating bytes')
            result, _, _, dst, _, progress = transfer('resume-unsupported', mode='resume-unsupported')
            expect(result == 1 and dst.stat().st_size == 0 and not progress, 'Unsupported resume-key capability falls back without data writes')
            result, _, src, dst, content, progress = transfer('unsupported', mode='unsupported')
            expect(result == 1 and dst.stat().st_size == 0 and not any(done > 0 for done, _ in progress), 'Unsupported COPYCHUNK safely returns fallback before any write')
            result, _, src, dst, content, progress = transfer('cancelled', cancel_after=1)
            expect(result == 4 and sum(done > 0 for done, _ in progress) == 1 and dst.stat().st_size == 1024 * 1024, 'Cancellation waits for the current chunk and stops the next')
            expect(src.read_bytes() == content, 'Cancellation never changes the source')
            result, _, _, dst, _, progress = transfer('wrong-object', wrong_target=True)
            expect(result == 1 and dst.stat().st_size == 0 and not progress, 'A remote object not matching the held inode is never written')
            result, _, _, _, _, progress = transfer('invalid-count', mode='invalid-count')
            expect(result == 3 and not any(done > 0 for done, _ in progress), 'Malformed byte/chunk counts preserve an uncertain destination without reporting progress')
            result, _, _, _, _, progress = transfer('short-reply', mode='short-reply')
            expect(result == 3 and not any(done > 0 for done, _ in progress), 'Truncated protocol replies preserve an uncertain destination')
            result, _, src, dst, content, progress = transfer('disconnect', mode='disconnect')
            expect(result == 3 and src.read_bytes() == content and dst.stat().st_size > 0, 'Disconnect after remote write returns uncertain status with both files retained')
            result, _, src, dst, content, progress = transfer('delayed', mode='delayed')
            expect(result == 3 and src.read_bytes() == content and dst.stat().st_size > 0 and not any(done > 0 for done, _ in progress), 'An unacknowledged write reaches a bounded deadline and retains both files')
            # Python ignores SIGPIPE, which can hide an AppKit process-exit bug.
            # A separate client restores the normal disposition and drops only its
            # own TCP connection after one acknowledged data chunk.
            signal_source, signal_target = source / 'sigpipe', destination / 'sigpipe'
            signal_payload = bytes(range(256)) * 8192
            signal_source.write_bytes(signal_payload); signal_target.touch()
            child = r"""
import ctypes, os, signal, sys
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
lib = ctypes.CDLL(sys.argv[1])
lib.mx_smb_connect.argtypes = [ctypes.c_char_p] * 6 + [ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
lib.mx_smb_connect.restype = ctypes.c_void_p
lib.mx_smb_destroy.argtypes = [ctypes.c_void_p]
lib.mx_fixture_socket_no_sigpipe.argtypes = [ctypes.c_void_p]
lib.mx_fixture_drop_socket.argtypes = [ctypes.c_void_p]
Cancel = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
Progress = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint64)
lib.mx_smb_copy.argtypes = [ctypes.c_void_p] + [ctypes.c_char_p] * 4 + [ctypes.c_int] * 2 + [Cancel, Progress, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
error = ctypes.c_int()
session = lib.mx_smb_connect(sys.argv[2].encode(), b'SRC', b'DST', b'fixture', b'', b'fixture-password', 0, ctypes.byref(error))
assert session and lib.mx_fixture_socket_no_sigpipe(session) == 1
from_fd = os.open(os.path.join(sys.argv[3], 'sigpipe'), os.O_RDONLY)
to_fd = os.open(os.path.join(sys.argv[4], 'sigpipe'), os.O_RDWR)
@Cancel
def cancelled(_): return 0
@Progress
def progress(_, done, total):
    if done > 0: lib.mx_fixture_drop_socket(session)
result = lib.mx_smb_copy(session, os.fsencode(sys.argv[3]), os.fsencode(sys.argv[4]), b'sigpipe', b'sigpipe', from_fd, to_fd, cancelled, progress, None, ctypes.byref(error))
os.close(from_fd); os.close(to_fd); lib.mx_smb_destroy(session)
assert result == 3, (result, error.value)
print('sigpipe-default-survived-uncertain')
"""
            fixture.mode = 'success'
            checked = subprocess.run([sys.executable, '-I', '-c', child, str(library), endpoint.decode(), str(source), str(destination)], capture_output=True, text=True, timeout=15)
            expect(checked.returncode == 0 and checked.stdout.strip() == 'sigpipe-default-survived-uncertain',
                   f'Per-socket SIGPIPE protection preserves the process and reports uncertainty (exit {checked.returncode})')
            expect(signal_source.read_bytes() == signal_payload and signal_target.stat().st_size == 1024 * 1024,
                   'The disconnected client preserves its original source and partially written destination')
            session, _ = connect(password=b'wrong-password')
            expect(not session, 'Incorrect credentials fail without a data operation')
            if session: lib.mx_smb_destroy(session)
            session, _ = connect(encrypted=1)
            expect(not session, 'Required encryption is not silently downgraded for an SMB2-only fixture')
            if session: lib.mx_smb_destroy(session)
            expect(fixture.reads == 0 and fixture.writes == 0, 'Error paths also perform no client-side payload READ/WRITE')
        finally:
            fixture.stop()
    print(f'SMB wire transport: {checks} checks passed; loopback only, no mounted shares or NAS files')

if __name__ == '__main__':
    main()
