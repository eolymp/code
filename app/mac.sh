#!/usr/bin/env bash
# Signs the macOS app, has Apple notarize it and packs it into a disk image.
# Usage: mac.sh <app> <dmg> <entitlements folder>
# Without EOLYMP_CODE_SIGN_IDENTITY the signature is ad hoc; without APPLE_API_KEY nothing is notarized.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app="$1"
dmg="$2"
plists="$3"
identity="${EOLYMP_CODE_SIGN_IDENTITY:-}"
tmp="$(mktemp -d)"

sign() {
  if [ -n "$identity" ]; then
    codesign --force --timestamp --options runtime --sign "$identity" "$@"
  else
    codesign --force --sign - "$@"
  fi
}

notarize() {
  [ -n "${APPLE_API_KEY:-}" ] || return 0
  xcrun notarytool submit "$1" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$2"
}

find "$app" -type f \( -perm +111 -o -name '*.dylib' -o -name '*.node' -o -name '*.so' \) -print0 \
  | while IFS= read -r -d '' file; do
      if file -b "$file" | grep -q '^Mach-O'; then printf '%s\t%s\n' "$(printf '%s' "$file" | tr -cd / | wc -c | tr -d ' ')" "$file"; fi
    done | sort -rn | cut -f2- > "$tmp/binaries"
while IFS= read -r file; do
  sign "$file"
done < "$tmp/binaries"

find "$app/Contents/Frameworks" -depth -name '*.framework' -print0 | while IFS= read -r -d '' bundle; do
  sign "$bundle"
done
for helper in "$app/Contents/Frameworks"/*.app; do
  case "$helper" in
    *"(GPU).app") plist=helper-gpu-entitlements.plist ;;
    *"(Plugin).app") plist=helper-plugin-entitlements.plist ;;
    *"(Renderer).app") plist=helper-renderer-entitlements.plist ;;
    *) plist=helper-entitlements.plist ;;
  esac
  sign --entitlements "$plists/$plist" "$helper"
done
sign --entitlements "$plists/app-entitlements.plist" "$app"
codesign --verify --deep --strict "$app"

if [ -n "${APPLE_API_KEY:-}" ]; then
  ditto -c -k --keepParent "$app" "$tmp/app.zip"
  notarize "$tmp/app.zip" "$app"
fi

mkdir "$tmp/image"
ditto "$app" "$tmp/image/$(basename "$app")"
ln -s /Applications "$tmp/image/Applications"
[ ! -e "$here/dmg.DS_Store" ] || cp "$here/dmg.DS_Store" "$tmp/image/.DS_Store"
rm -f "$dmg"
hdiutil create -quiet -volname "Eolymp Code" -srcfolder "$tmp/image" -format ULMO "$dmg"
if [ -n "$identity" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
fi
notarize "$dmg" "$dmg"
rm -rf "$tmp"
