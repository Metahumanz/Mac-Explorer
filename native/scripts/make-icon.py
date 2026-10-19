#!/usr/bin/env python3
"""Reuse the project's selected app artwork with macOS image tools."""
import argparse
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
source = root.parent / 'design' / 'icon-selected-mirrored.png'
output = args.output.resolve()
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='mac-explorer-native-icon-') as temporary:
    iconset = pathlib.Path(temporary) / 'AppIcon.iconset'
    iconset.mkdir()
    for size in [16, 32, 128, 256, 512]:
        for scale in [1, 2]:
            name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
            subprocess.run(['/usr/bin/sips', '-z', str(size * scale), str(size * scale), str(source), '--out', str(iconset / name)], check=True, capture_output=True)
    subprocess.run(['/usr/bin/iconutil', '-c', 'icns', str(iconset), '-o', str(output)], check=True)
print(output)
