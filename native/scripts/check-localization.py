#!/usr/bin/env python3
"""Check every native UI/error translation and preserve interpolation slots."""
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[1]
keys = set()
for source in (root / 'Sources').rglob('*.swift'):
    if source.stem.endswith('Checks') or source.stem == 'NativeSmoke':
        continue
    for text in re.findall(r'(?:NL|failure)\("((?:[^"\\]|\\.)*)"', source.read_text()):
        if not re.search(r'[\u4e00-\u9fff]', text):
            continue
        key = json.loads('"' + text + '"')
        if re.search(r'[\u4e00-\u9fff]', key):
            assert "%@" not in key, (source.name, key, "Use indexed native placeholders")
            keys.add(key)
for language in ['en', 'zh-TW']:
    catalog = json.loads((root / 'Resources/locales' / (language + '.json')).read_text())
    for key in sorted(keys):
        assert key in catalog and catalog[key], (language, key)
        assert sorted(re.findall(r'\{\d+\}', key)) == sorted(re.findall(r'\{\d+\}', catalog[key])), (language, key, 'placeholder mismatch')
print(f'Localization: {len(keys)} source strings checked in both catalogs.')
