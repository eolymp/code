#!/usr/bin/env bash
# Builds the editor. Usage: build.sh [build|package]; output in artifacts/.
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
  if [ "$platform" = darwin ]; then bundled="$built/Eolymp Code.app/Contents/Resources/app/extensions"; else bundled="$built/resources/app/extensions"; fi
  for extension in "$bundled"/*/; do
    name="$(basename "$extension")"
    grep -qx "$name" "$here/extensions.keep" || rm -rf "${bundled:?}/$name"
  done
fi

[ "$step" != build ] || exit 0
out="$repo/artifacts"
mkdir -p "$out"
if [ "$platform" = darwin ]; then
  if [ -n "${EOLYMP_CODE_SIGN_IDENTITY:-}" ]; then
    codesign --force --deep --options runtime --timestamp --entitlements "$work/vscodium/vscode/build/azure-pipelines/darwin/app-entitlements.plist" --sign "$EOLYMP_CODE_SIGN_IDENTITY" "$built/Eolymp Code.app"
  else
    codesign --force --deep --sign - "$built/Eolymp Code.app"
  fi
  rm -f "$out/EolympCode-$platform-$arch-$version.zip"
  ditto -c -k --keepParent "$built/Eolymp Code.app" "$out/EolympCode-$platform-$arch-$version.zip"
elif [ "$platform" = linux ]; then
  tar -czf "$out/EolympCode-$platform-$arch-$version.tar.gz" -C "$built" .
else
  (cd "$built" && 7z a -tzip "$out/EolympCode-$platform-$arch-$version.zip" . >/dev/null)
fi
ls -lh "$out"
