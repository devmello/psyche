#!/bin/sh
# Resets the macOS privacy grants of Psyche Helper so the permission flows can be tested again,
# or recovers after an ad-hoc rebuild minted a new code identity (security §12).
# Usage: apps/mac-helper/scripts/tcc-reset.sh [bundle id]   (default com.psyche.helper)
# Notifications are not TCC: remove them in System Settings › Notifications.
set -u
BUNDLE="${1:-com.psyche.helper}"
for service in Accessibility ScreenCapture AppleEvents ListenEvent PostEvent Microphone SpeechRecognition \
               Calendar Reminders AddressBook SystemPolicyAllFiles; do
  if tccutil reset "$service" "$BUNDLE" >/dev/null 2>&1; then
    echo "reset $service"
  else
    echo "skip  $service (not supported here)"
  fi
done
echo "Restart Psyche Helper; macOS asks again on first use."
