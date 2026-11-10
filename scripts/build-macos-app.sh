#!/usr/bin/env bash
# Herdr CKD — macOS Application Bundle (Herdr CKD.app) 생성 스크립트 (Mac Apple Silicon 지원)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_BUNDLE="$PROJECT_ROOT/Herdr CKD.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

cd "$PROJECT_ROOT"

if [ ! -f "$PROJECT_ROOT/dist/src/ui-server.js" ]; then
  echo "[Herdr CKD] Building TypeScript sources..."
  npm run build
fi

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

if [ -f "$PROJECT_ROOT/assets/herdr-ckd.png" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET_DIR="$PROJECT_ROOT/assets/AppIcon.iconset"
  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"
  sips -z 16 16     "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null 2>&1
  sips -z 32 32     "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null 2>&1
  sips -z 32 32     "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null 2>&1
  sips -z 64 64     "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null 2>&1
  sips -z 128 128   "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null 2>&1
  sips -z 256 256   "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null 2>&1
  sips -z 256 256   "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null 2>&1
  sips -z 512 512   "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null 2>&1
  sips -z 512 512   "$PROJECT_ROOT/assets/herdr-ckd.png" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null 2>&1
  iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns" >/dev/null 2>&1 || true
  rm -rf "$ICONSET_DIR"
fi

cat > "$CONTENTS_DIR/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Herdr CKD</string>
  <key>CFBundleDisplayName</key>
  <string>Herdr CKD</string>
  <key>CFBundleIdentifier</key>
  <string>dev.herdr.ckd</string>
  <key>CFBundleVersion</key>
  <string>0.2.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>Herdr-CKD</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

cat > "$MACOS_DIR/Herdr-CKD" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

MACOS_BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$MACOS_BIN_DIR/../../.." && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1 || true)"
  if [ -n "$LATEST_NVM_NODE" ]; then
    export PATH="$HOME/.nvm/versions/node/$LATEST_NVM_NODE/bin:$PATH"
  fi
fi

export HERDR_APP_ROOT="$APP_ROOT"
cd "$APP_ROOT"

exec node "$APP_ROOT/dist/src/ui-server.js" "$@"
EOF

chmod +x "$MACOS_DIR/Herdr-CKD"
chmod +x "$PROJECT_ROOT/Herdr-CKD.command" 2>/dev/null || true

echo "[Herdr CKD] macOS 앱 번들 생성 완료: $APP_BUNDLE"
