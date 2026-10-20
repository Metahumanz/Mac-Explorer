#!/usr/bin/env python3
"""Check Fork installs and collision rejection using signed temporary fixtures only."""
import importlib.util
import pathlib
import plistlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fork_installer', root / 'scripts/install-fork.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
checks = 0


def expect(condition):
    global checks
    assert condition
    checks += 1


def rejected(source, destination):
    try:
        installer.install(source, destination)
    except (RuntimeError, OSError):
        return
    raise AssertionError('Install unexpectedly succeeded')


with tempfile.TemporaryDirectory(prefix='mac-explorer-fork-install-check-') as temporary:
    fixture = pathlib.Path(temporary).resolve()
    source = fixture / 'source' / installer.APP_NAME
    (source / 'Contents/MacOS').mkdir(parents=True)
    binary = source / 'Contents/MacOS/MacExplorerNative'
    subprocess.run(['/usr/bin/clang', '-arch', 'arm64', '-x', 'c', '-', '-o', str(binary)], input='int main(void) { return 0; }\n', text=True, check=True)
    info = {'CFBundleIdentifier': installer.BUNDLE_ID, 'CFBundleExecutable': 'MacExplorerNative', 'CFBundleShortVersionString': '1.1.0', 'CFBundlePackageType': 'APPL', 'MacExplorerBuildProfile': 'fork'}
    (source / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(source)], check=True)
    destination = fixture / 'applications with spaces'; destination.mkdir()
    original = destination / 'Mac Explorer.app'; original.mkdir(); sentinel = original / 'keep'; sentinel.write_text('original app')
    installed = installer.install(source, destination)
    expect(installed.name == installer.APP_NAME and installer.verify(installed) == installer.verify(source))
    expect(sentinel.read_text() == 'original app')
    before = installer.verify(installed)
    rejected(source, destination)
    expect(installer.verify(installed) == before and sentinel.read_text() == 'original app')
    collision = fixture / 'collision'; collision.mkdir(); (collision / installer.APP_NAME).write_text('keep existing file')
    rejected(source, collision); expect((collision / installer.APP_NAME).read_text() == 'keep existing file')
    links = fixture / 'links'; links.mkdir(); (links / installer.APP_NAME).symlink_to(original)
    rejected(source, links); expect((links / installer.APP_NAME).is_symlink() and sentinel.read_text() == 'original app')
    directory_link = fixture / 'linked-directory'; directory_link.symlink_to(destination, target_is_directory=True)
    rejected(source, directory_link); expect(sentinel.read_text() == 'original app')
    invalid = fixture / 'invalid'; invalid.mkdir()
    info['CFBundleIdentifier'] = 'local.macexplorer.native-prototype'
    (source / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(source)], check=True)
    rejected(source, invalid); expect(not list(invalid.iterdir()))
print(f'Fork installation checks passed: {checks}; original app and collisions preserved, no real Applications writes.')
