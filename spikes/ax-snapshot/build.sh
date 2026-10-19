#!/bin/sh
# Builds .build/AXSnap.app (bundle id com.psyche.spike.axsnap) and .build/axrun.
# Usage: ./build.sh [codesign identity]   default: first "Apple Development" identity, else ad-hoc.
#
# TCC pitfalls (see docs/spikes/spike-04-ax-snapshot.md):
# - A process launched from a shell is attributed to its *responsible* process (the terminal,
#   or the Claude Code CLI under Claude.app's `disclaimer`). axrun spawns axsnap with
#   responsibility disclaimed so the grant belongs to AXSnap.app.
# - An ad-hoc signature changes every build, so the grant silently stops matching after a
#   rebuild. A real certificate + fixed path keeps it. Recovery: tccutil reset Accessibility
#   com.psyche.spike.axsnap
set -eu
cd "$(dirname "$0")"
ID="${1:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')}"
ID="${ID:--}"
APP=.build/AXSnap.app
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.psyche.spike.axsnap</string>
<key>CFBundleName</key><string>AXSnap</string>
<key>CFBundleExecutable</key><string>axsnap</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PL
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/axsnap" Sources/axsnap/main.swift
clang -O2 -o .build/axrun Sources/axrun/axrun.c
codesign --force --sign "$ID" "$APP"
codesign --force --sign "$ID" --identifier com.psyche.spike.axrun .build/axrun
codesign -dv "$APP" 2>&1 | grep -E 'Identifier|Signature|TeamIdentifier|Authority=Apple Dev'
