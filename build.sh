#!/usr/bin/env bash
# Assembles dist/: the installers and a content-addressed folder with the release files.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/files
(cd extension && npx --yes @vscode/vsce@4.1.1 package --out ../dist/files/eolymp-code.vsix)
(cd l10n/uk && npx --yes @vscode/vsce@4.1.1 package --out ../../dist/files/eolymp-code-uk.vsix)
cp editor/settings.json setup/clang-format editor/icon.png dist/files/
cp editor/pins.txt dist/pins.txt
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
for file in dist/files/*; do
  echo "all $(digest "$file") $(basename "$file")" >> dist/pins.txt
done
for archive in artifacts/EolympCode-*; do
  [ -e "$archive" ] || continue
  name="$(basename "$archive")"
  cp "$archive" dist/files/
  case "$name" in *.dmg) continue ;; esac
  echo "$(echo "$name" | cut -d- -f2-3) $(digest "$archive") $name" >> dist/pins.txt
done
mv dist/pins.txt dist/files/pins.txt
pins="$(digest dist/files/pins.txt)"
release="${pins:0:12}"
mv dist/files "dist/$release"
for installer in install.sh install.ps1; do
  sed -e "s/@RELEASE@/$release/" -e "s/@PINS@/$pins/" "install/$installer" > "dist/$installer"
done
echo "release $release"
