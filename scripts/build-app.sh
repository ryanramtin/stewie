#!/bin/bash
# Builds Stewie.app and installs it.
# usage: build-app.sh [--icon path/to/icon.png] [--dest /Applications]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$ROOT/scripts/Stewie.app"
DEST=""
ICON=""

while [ $# -gt 0 ]; do
  case "$1" in
    --icon) ICON="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# Prefer the OK Stewie brand icon when it is on this machine.
DEFAULT_ICON="$HOME/ok-stewie-partners-l5/assets/images/icon.png"
if [ -z "$ICON" ] && [ -f "$DEFAULT_ICON" ]; then ICON="$DEFAULT_ICON"; fi

if [ -n "$ICON" ] && [ -f "$ICON" ]; then
  python3 "$ROOT/scripts/make-icns.py" "$ICON" --out "$ROOT/.build/AppIcon.icns"
else
  node "$ROOT/scripts/make-icon.mjs"
fi

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
touch "$APP"

echo "installed $APP"
