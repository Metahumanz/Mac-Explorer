#!/usr/bin/env python3
"""Install the signed Fork bundle beside the original; never replace any target."""
import argparse
import ctypes
import hashlib
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile

APP_NAME = 'Mac Explorer Fork.app'
BUNDLE_ID = 'local.macexplorer.native-fork'


def verify(app):
    if app.name != APP_NAME or app.is_symlink() or not app.is_dir() or any(p.is_symlink() for p in app.rglob('*')):
        raise RuntimeError('Expected a non-symlink Mac Explorer Fork bundle.')
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != BUNDLE_ID or info.get('CFBundleExecutable') != 'MacExplorerNative':
        raise RuntimeError('Fork identity mismatch; no application was changed.')
    if info.get('MacExplorerBuildProfile') != 'fork':
        raise RuntimeError('Expected an explicit Fork build.')
    subprocess.run(['/usr/bin/lipo', str(app / 'Contents/MacOS/MacExplorerNative'), '-verify_arch', 'arm64'], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    return {str(p.relative_to(app)): hashlib.file_digest(p.open('rb'), 'sha256').hexdigest() for p in app.rglob('*') if p.is_file()}


def install(source, directory):
    if sys.platform != 'darwin':
        raise RuntimeError('The Fork installer requires macOS.')
    source = source.absolute()
    expected = verify(source)
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise RuntimeError('Choose an existing absolute installation directory.')
    directory = directory.resolve(strict=True)
    destination = directory / APP_NAME
    if os.path.lexists(destination):
        raise RuntimeError(f'Destination already exists; nothing replaced: {destination}')
    with tempfile.TemporaryDirectory(prefix='.mac-explorer-fork-', dir=directory) as staging:
        staged = pathlib.Path(staging) / APP_NAME
        shutil.copytree(source, staged)
        if verify(staged) != expected:
            raise RuntimeError('Staged Fork files differ from the signed build.')
        # Darwin sys/stdio.h: RENAME_EXCL = 0x00000004. Never merge or replace a racing target.
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(os.fsencode(staged), os.fsencode(destination), 0x00000004) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code), str(destination))
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / 'output/fork' / APP_NAME)
    parser.add_argument('--directory', type=pathlib.Path, default=pathlib.Path('/Applications'))
    args = parser.parse_args()
    try:
        destination = install(args.app, args.directory)
        print(f'Installed without replacing existing apps: {destination}')
    except Exception as error:
        parser.exit(1, f'Fork install failed: {error}\n')


if __name__ == '__main__':
    main()
