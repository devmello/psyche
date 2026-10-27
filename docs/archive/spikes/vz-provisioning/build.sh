#!/bin/sh
# Builds vzspike and the guest payload, then ad-hoc signs vzspike with the
# virtualization entitlement (without it every VZ call, including
# VZMacOSRestoreImage.fetchLatestSupported, fails with VZErrorDomain 10001).
set -eu
cd "$(dirname "$0")"
swift build -c release
codesign -s - -f --entitlements vzspike.entitlements .build/release/vzspike
mkdir -p .build/guest
# Guest binaries: same arch, deployment target 26 so they also run in a 26 guest.
clang -O2 -mmacosx-version-min=26.0 -o .build/guest/vsock-bridge guest/vsock-bridge.c
xcrun swiftc -O -target arm64-apple-macos26.0 -o .build/guest/axcheck guest/axcheck.swift
codesign -s - -f -i dev.psyche.spike.vsock-bridge .build/guest/vsock-bridge
codesign -s - -f -i dev.psyche.spike.axcheck .build/guest/axcheck
echo "built .build/release/vzspike and .build/guest/*"
