#!/usr/bin/env bash
# Assembles dist/: the installers and a content-addressed folder with the release files.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/files
(cd extension && npx --yes @vscode/vsce@4.1.1 package --out ../dist/files/eolymp-code.vsix)
cp editor/icon.png dist/files/
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
echo "all $(digest dist/files/icon.png) icon.png" > dist/pins.txt
for archive in artifacts/EolympCode-*; do
  [ -e "$archive" ] || continue
  name="$(basename "$archive")"
  cp "$archive" dist/files/
  case "$name" in *.dmg|*.exe) continue ;; esac
  echo "$(echo "$name" | cut -d- -f2-3) $(digest "$archive") $name" >> dist/pins.txt
done
mv dist/pins.txt dist/files/pins.txt
pins="$(digest dist/files/pins.txt)"
release="${pins:0:12}"
mv dist/files "dist/$release"
sed -e "s/@RELEASE@/$release/" -e "s/@PINS@/$pins/" install/install.sh > dist/install.sh
echo "release $release"
