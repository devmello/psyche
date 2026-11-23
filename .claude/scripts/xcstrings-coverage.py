#!/usr/bin/env python3
"""Every key in an iOS string catalog that has any translation must have all 11 locales (en + the 10
languages). #1542 shipped 10 keys without zh-Hans and only the verifier noticed.
Usage: xcstrings-coverage.py <catalog.xcstrings>...   Exit 1 and list the gaps if any."""
import json
import sys

LANGS = {"ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh-Hans"}
bad = 0
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as f:
        strings = json.load(f).get("strings", {})
    for key, entry in strings.items():
        if entry.get("shouldTranslate") is False:
            continue
        have = set(entry.get("localizations", {}))
        if have and not LANGS <= have:
            bad += 1
            print(f"{path}: {key!r} is missing {', '.join(sorted(LANGS - have))}")
sys.exit(1 if bad else 0)
