#!/bin/bash
# Builds both launchers and installs them.
#   Ok Stewie.app      -> your web app (127.0.0.1:8093), starts it if down
#   Stewie Console.app -> the agent dashboard (127.0.0.1:4321)
# usage: build-app.sh [--dest DIR]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$DEST" ]; then
  if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; fi
fi

WEB_ICON="$HOME/ok-stewie-partners-l5/assets/images/ios-icon-dark.png"

install_app() {
  local name="$1" src="$2" icon_src="$3"
  local app="$DEST/$name.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$src/Contents/Info.plist" "$app/Contents/Info.plist"
  cp "$src/Contents/MacOS/launch" "$app/Contents/MacOS/launch"
  chmod +x "$app/Contents/MacOS/launch"
  cp "$icon_src" "$app/Contents/Resources/AppIcon.icns"
  xattr -cr "$app" 2>/dev/null || true
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || true
  touch "$app"
  echo "installed $app"
}

# web app icon: the real Ok Stewie mark, squircle-masked
if [ -f "$WEB_ICON" ]; then
  python3 "$ROOT/scripts/make-icns.py" "$WEB_ICON" --out "$ROOT/.build/web-icon.icns" >/dev/null
else
  node "$ROOT/scripts/make-icon.mjs" >/dev/null
  cp "$ROOT/.build/AppIcon.icns" "$ROOT/.build/web-icon.icns"
fi

# console icon: the generated node-graph mark
node "$ROOT/scripts/make-icon.mjs" >/dev/null

mkdir -p "$HOME/.stewie"
rm -rf "$DEST/Stewie.app" # legacy name from the first build

install_app "Ok Stewie" "$ROOT/scripts/apps/OkStewie" "$ROOT/.build/web-icon.icns"
install_app "Stewie Console" "$ROOT/scripts/apps/StewieConsole" "$ROOT/.build/AppIcon.icns"
