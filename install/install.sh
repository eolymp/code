#!/usr/bin/env bash
set -euo pipefail

RELEASE="@RELEASE@"
PINS="@PINS@"
BASE_URL="${EOLYMP_CODE_URL:-https://downloads.eolymp.com/code}/$RELEASE"
DEST="${EOLYMP_CODE_HOME:-$HOME/.local/share/eolymp-code}"
WORK="$HOME/Eolymp/practice"
started=$(date +%s)

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
fetch() { curl -fL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --progress-bar -o "$2" "$1" || { echo "could not download $1"; exit 1; }; }
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "unsupported processor: $(uname -m)"; exit 1 ;;
esac

case "$(uname -s)" in
  Linux) os=linux; data="$DEST/editor/data" ;;
  Darwin) echo "On macOS, download Eolymp Code from https://downloads.eolymp.com/code/EolympCode-macos-$arch.dmg"; exit 1 ;;
  *) echo "unsupported system: $(uname -s)"; exit 1 ;;
esac

mkdir -p "$DEST/downloads" "$WORK"

step "Downloading the editor and its extensions"
fetch "$BASE_URL/pins.txt" "$DEST/downloads/pins.txt"
[ "$(digest "$DEST/downloads/pins.txt")" = "$PINS" ] || { echo "the list of downloads is damaged or was replaced"; exit 1; }
pinned="$DEST/downloads/pinned"
mkdir -p "$pinned"
extensions=()
while read -r platform checksum url; do
  [ "$platform" = "$os-$arch" ] || [ "$platform" = all ] || continue
  case "$url" in *://*) ;; *) url="$BASE_URL/$url" ;; esac
  file="$DEST/downloads/pinned/${url##*/}"
  echo "${url##*/}"
  fetch "$url" "$file"
  [ "$(digest "$file")" = "$checksum" ] || { echo "this download is damaged or was replaced: $url"; exit 1; }
  case "$file" in
    *.vsix) extensions+=("$file") ;;
    */EolympCode-*) editor="$file" ;;
  esac
done < "$DEST/downloads/pins.txt"
[ -n "${editor:-}" ] || { echo "no editor build for $os-$arch"; exit 1; }
kept="$DEST/data.kept"
if [ -d "$data" ]; then
  rm -rf "$kept"
  mv "$data" "$kept"
fi
fresh=yes
[ -d "$kept" ] && fresh=no
rm -rf "$DEST/editor"
mkdir -p "$DEST/editor"
tar -xzf "$editor" -C "$DEST/editor"
sudo chown root:root "$DEST/editor/chrome-sandbox"
sudo chmod 4755 "$DEST/editor/chrome-sandbox"
codium="$DEST/editor/bin/eolymp-code"
cp "$pinned/icon.png" "$DEST/icon.png"
[ "$fresh" = yes ] || mv "$kept" "$data"
mkdir -p "$data/user-data/User"
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  uk_*|uk-*) [ -e "$data/argv.json" ] || printf '{ "locale": "uk" }\n' > "$data/argv.json" ;;
esac

step "Writing the editor's settings"
[ -e "$data/user-data/User/settings.json" ] || cp "$pinned/settings.json" "$data/user-data/User/settings.json"

step "Installing the extensions"
for extension in "${extensions[@]}"; do
  "$codium" --install-extension "$extension" --force
done
"$codium" --uninstall-extension ms-python.vscode-python-envs || true

step "Creating the first problem and the launcher"
cp "$pinned/clang-format" "$(dirname "$WORK")/.clang-format"
sample="$WORK/sum/sum.cpp"
if [ ! -e "$WORK/sum" ]; then
  mkdir -p "$WORK/sum"
  printf '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    int a, b;\n    cin >> a >> b;\n    cout << a + b << '"'"'\\n'"'"';\n    return 0;\n}\n' > "$sample"
  printf '12\n9\n' > "$WORK/sum/1.in"
  printf '21\n' > "$WORK/sum/1.answer"
fi
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/eolymp-code.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Eolymp Code
Comment=Write and test competitive programming solutions
Exec="$DEST/editor/eolymp-code" --password-store=basic "$WORK" "$sample"
Icon=$DEST/icon.png
Categories=Development;IDE;
StartupWMClass=Eolymp Code
DESKTOP

rm -rf "$DEST/downloads"
step "Done in $(( $(date +%s) - started )) seconds. Starting Eolymp Code"
nohup "$DEST/editor/eolymp-code" --password-store=basic "$WORK" "$sample" >/dev/null 2>&1 &
