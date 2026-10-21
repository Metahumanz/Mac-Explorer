#!/usr/bin/env python3
"""Check the actual discovery bridge without sending files or changing receive settings."""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='explorer-airdrop-checks-') as temporary:
    binary = pathlib.Path(temporary) / 'airdrop-checks'
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '5',
                    str(root / 'Sources/MacExplorerNative/NativeAirDrop.swift'),
                    str(root / 'scripts/AirDropChecks.swift'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=20)
