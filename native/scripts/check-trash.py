#!/usr/bin/env python3
"""Check undo identity and simulated multi-volume Trash; never use the real Trash."""
import pathlib
import platform
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="explorer-trash-build-") as temporary:
    sources = [root / "Sources" / "ExplorerCore" / f"{name}.swift" for name in ["Localization", "FileEntry", "DirectoryReader", "FileActions", "TrashStore"]]
    for name in ["FileActionChecks", "TrashChecks"]:
        executable = pathlib.Path(temporary) / name
        subprocess.run([
            "xcrun", "swiftc", "-parse-as-library", "-swift-version", "5", "-O",
            "-target", f"{platform.machine()}-apple-macos13.0",
            *map(str, sources), str(root / "scripts" / f"{name}.swift"), "-o", str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True)
