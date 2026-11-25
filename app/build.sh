#!/usr/bin/env bash
# Builds the editor. Usage: build.sh [build|package]; output in artifacts/: a disk image, a setup program, or a .deb and an archive.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
work="${EOLYMP_CODE_BUILD_DIR:-$repo/.build}"
version="$(cat "$here/version")"
step="${1:-all}"

case "$(uname -s)" in
  Darwin) os=osx; platform=darwin ;;
  Linux) os=linux; platform=linux ;;
  *) os=windows; platform=win32 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  *) arch=x64 ;;
esac

built="$work/vscodium/VSCode-$platform-$arch"

if [ "$step" != package ]; then
mkdir -p "$work"
if [ ! -d "$work/vscodium/.git" ]; then
  git clone --depth 1 --branch "$version" https://github.com/VSCodium/vscodium.git "$work/vscodium"
fi
cd "$work/vscodium"
git checkout -q -- .
if [ "$(git describe --tags --exact-match 2>/dev/null)" != "$version" ]; then
  git fetch -q --depth 1 origin tag "$version"
  git checkout -q "$version"
fi
git clean -qfd patches/user src
fi
cd "$work/vscodium"

wanted="$(cat .nvmrc)"
if [ "$(node --version 2>/dev/null)" != "v$wanted" ]; then
  if [ "$platform" = win32 ]; then
    echo "node $wanted is needed (found $(node --version 2>/dev/null || echo none))"
    exit 1
  fi
  node="node-v$wanted-$platform-$arch"
  if [ ! -x "$work/$node/bin/node" ]; then
    curl -fL --retry 3 -o "$work/$node.tar.gz" "https://nodejs.org/dist/v$wanted/$node.tar.gz"
    expected="$(grep " $node.tar.gz\$" "$here/node.sha256" | cut -d' ' -f1)"
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$work/$node.tar.gz" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$work/$node.tar.gz" | cut -d' ' -f1)"; fi
    [ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "the Node download does not match app/node.sha256"; exit 1; }
    tar -xzf "$work/$node.tar.gz" -C "$work"
    rm "$work/$node.tar.gz"
  fi
  export PATH="$work/$node/bin:$PATH"
fi

export APP_NAME="Eolymp Code"
export BINARY_NAME="eolymp-code"
export ORG_NAME="Eolymp"
export GLOBAL_DIRNAME="eolymp-code"
export GH_REPO_PATH="eolymp/code"
export ASSETS_REPOSITORY="eolymp/code"
export OS_NAME="$os"
export VSCODE_ARCH="$arch"
export VSCODE_QUALITY="stable"
export RELEASE_VERSION="$version"
export CI_BUILD="no"
export SHOULD_BUILD="yes"
export SHOULD_BUILD_REH="no"
export SHOULD_BUILD_REH_WEB="no"
export SHOULD_BUILD_CLI="no"
export DISABLE_UPDATE="yes"
export VSCODE_SKIP_NODE_VERSION_CHECK="yes"

if [ "$step" != package ]; then
for candidate in python3.11 python3.12 python3.13; do
  if command -v "$candidate" >/dev/null 2>&1; then
    export npm_config_python="$(command -v "$candidate")"
    break
  fi
done

jq -s '.[0] * .[1]' product.json "$here/product.json" > product.json.merged
mv product.json.merged product.json
cp -R "$here/src/." src/stable/
mkdir -p patches/user
find "$here/patches" -name '*.patch' -exec cp {} patches/user/ \;

rm -rf vscode "VSCode-$platform-$arch"
if ! command -v git-lfs >/dev/null 2>&1; then
  export GIT_CONFIG_COUNT=3
  export GIT_CONFIG_KEY_0=filter.lfs.process GIT_CONFIG_VALUE_0=
  export GIT_CONFIG_KEY_1=filter.lfs.smudge GIT_CONFIG_VALUE_1=
  export GIT_CONFIG_KEY_2=filter.lfs.required GIT_CONFIG_VALUE_2=false
fi
set +u
. get_repo.sh
. build.sh
set -u +x
fi

if [ "$step" != package ]; then
  if [ "$platform" = darwin ]; then resources="$built/Eolymp Code.app/Contents/Resources/app"; else resources="$built/resources/app"; fi
  bundled="$resources/extensions"
  for extension in "$bundled"/*/; do
    name="$(basename "$extension")"
    grep -qx "$name" "$here/extensions.keep" || rm -rf "${bundled:?}/$name"
  done
  node "$here/bundle.js" "$resources" "$platform-$arch" "$work/pins"
  [ "$platform" != win32 ] || (cd "$work/vscodium/vscode" && npm run gulp "vscode-win32-$arch-inno-updater")
  [ "$platform" != linux ] || (cd "$work/vscodium/vscode" && npm run gulp "vscode-linux-$arch-prepare-deb" && npm run gulp "vscode-linux-$arch-build-deb")
  [ "$platform" != darwin ] || (cp "$here/dmg/package.json" "$here/dmg/package-lock.json" "$work/vscodium" && cd "$work/vscodium" && npm ci --no-audit --no-fund)
fi

[ "$step" != build ] || exit 0
out="$repo/artifacts"
mkdir -p "$out"
if [ "$platform" = darwin ]; then
  for name in CERTIFICATE_OSX_P12_DATA CERTIFICATE_OSX_P12_PASSWORD CERTIFICATE_OSX_APPLE_ID CERTIFICATE_OSX_APP_PASSWORD CERTIFICATE_OSX_TEAM_ID; do
    [ -n "${!name:-}" ] || { echo "$name is needed to sign the disk image"; exit 1; }
  done
  export SHOULD_BUILD_ZIP=no
  rm -rf assets
  mkdir assets
  set +u
  . build/osx/prepare_assets.sh
  set -u
  rm -f "$APP_NAME.p12"
  dmg="assets/$APP_NAME.$arch.$version.dmg"
  xcrun notarytool submit "$dmg" --apple-id "$CERTIFICATE_OSX_APPLE_ID" --team-id "$CERTIFICATE_OSX_TEAM_ID" --password "$CERTIFICATE_OSX_APP_PASSWORD" --wait
  xcrun stapler staple "$dmg"
  cp "$dmg" "$out/EolympCode-$platform-$arch-$version.dmg"
elif [ "$platform" = linux ]; then
  cp "$work"/vscodium/vscode/.build/linux/deb/*/deb/*.deb "$out/EolympCode-$platform-$arch-$version.deb"
  tar -czf "$out/EolympCode-$platform-$arch-$version.tar.gz" -C "$built" .
else
  (cd "$work/vscodium/vscode" && npm run gulp "vscode-win32-$arch-user-setup")
  cp "$work/vscodium/vscode/.build/win32-$arch/user-setup/VSCodeSetup.exe" "$out/EolympCode-$platform-$arch-$version.exe"
fi
ls -lh "$out"
