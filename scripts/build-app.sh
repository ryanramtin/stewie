#!/bin/bash
# Builds Stewie.app from this repo and installs it to /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$ROOT/scripts/Stewie.app"
DEST="${1:-}"

node "$ROOT/scripts/make-icon.mjs"

if [ -z "$DEST" ]; then
  if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; fi
fi
mkdir -p "$DEST" "$HOME/.stewie"
APP="$DEST/Stewie.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$APP_SRC/Contents/Info.plist" "$APP/Contents/Info.plist"
cp "$APP_SRC/Contents/MacOS/Stewie" "$APP/Contents/MacOS/Stewie"
chmod +x "$APP/Contents/MacOS/Stewie"
cp "$ROOT/.build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# refresh Launchpad/Spotlight cache for this bundle
touch "$APP"

echo "installed $APP"
