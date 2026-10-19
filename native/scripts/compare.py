#!/usr/bin/env python3
"""Compare actual native screenshots and geometry against the saved Electron fixture."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--skip-build", action="store_true")
parser.add_argument("--validation", action="store_true")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
output = root / "output" / "reference"
fixture = pathlib.Path((output / "fixture-path.txt").read_text().strip())
if fixture.name != "Documents" or not fixture.parent.name.startswith("explorer-reference-") or fixture.parent.parent.resolve() != pathlib.Path(tempfile.gettempdir()).resolve():
    raise RuntimeError("Run reference.mjs first; comparison only accepts its temporary fixtures")
if not args.skip_build:
    subprocess.run([sys.executable, "-I", str(root / "scripts" / "build.py")] + (["--validation"] if args.validation else []), check=True)
app_directory = root / "output" / "validation" if args.validation else root / "output"

def files():
    return {str(path.relative_to(fixture)): hashlib.sha256(path.read_bytes()).hexdigest() for path in fixture.rglob("*") if path.is_file() and not path.is_symlink()}

before = files()
report = output / "native-report.json"
if report.exists():
    report.unlink()
subprocess.run([str(app_directory / "Mac Explorer Native.app/Contents/MacOS/MacExplorerNative"), "--compare", str(fixture), "--report", str(report)], check=True, timeout=120)
data = json.loads(report.read_text())
reference = json.loads((output / "geometry.json").read_text())
geometry = data["geometry"]
differences = {name: {field: round(geometry[name][field] - expected[field], 3) for field in ["x", "y", "width", "height"]} for name, expected in reference.items()}
geometry_match = all(abs(value) <= 0.5 for fields in differences.values() for value in fields.values())
summary = {"geometryWithinHalfPoint": geometry_match, "geometryDifferences": differences, "fixtureFilesPreserved": files() == before, "reference": json.loads((output / "reference-version.json").read_text()), "note": "Geometry equality is not pixel or complete feature parity."}
(output / "comparison.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
subprocess.run(["xcrun", "swift", str(root / "scripts" / "CompareImages.swift"), str(output / "electron-details.png"), str(output / "native-details.png"), str(output / "details-side-by-side.png")], check=True)
print(json.dumps(summary, ensure_ascii=False, indent=2))
if not summary["fixtureFilesPreserved"] or not geometry_match or not data["passed"]:
    sys.exit(1)
