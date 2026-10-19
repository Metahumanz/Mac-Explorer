#!/usr/bin/env python3
"""Exercise native Git/SVN operations exclusively in disposable temporary repositories."""
import pathlib
import platform
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="explorer-vcs-build-") as temporary:
    executable = pathlib.Path(temporary) / "VCSChecks"
    sources = [root / "Sources" / "ExplorerCore" / f"{name}.swift" for name in ["NativeCommand", "Localization", "NativeVersionControl"]]
    subprocess.run([
        "xcrun", "swiftc", "-parse-as-library", "-swift-version", "5", "-O",
        "-target", f"{platform.machine()}-apple-macos13.0",
        *map(str, sources), str(root / "scripts" / "VCSChecks.swift"), "-o", str(executable),
    ], check=True)
    subprocess.run([str(executable)], check=True)
