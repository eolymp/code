#!/usr/bin/env bash
# Publishes a release from artifacts/ to downloads.eolymp.com, and a stable release to the apt repository at pkgs.eolymp.com/apt. Usage: publish.sh <version>; DOWNLOADS_BUCKET and APT_BUCKET name the S3 folders.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
version="$1"

case "$version" in *-*) channel=pre/ ;; *) channel= ;; esac
put() { aws s3 cp "$1" "$DOWNLOADS_BUCKET/$channel$2" --cache-control "$3"; }

for file in "$repo"/artifacts/eolymp-code-*; do
  name="$(basename "$file")"
  put "$file" "$version/${name%%.*}-$version.${name#*.}" "public, max-age=31536000, immutable"
done
for file in "$repo"/artifacts/eolymp-code-*; do
  put "$file" "$(basename "$file")" "public, max-age=300"
done
[ -z "$channel" ] || exit 0

latest="$(mktemp)"
jq --arg version "$version" '{version: $version} + .' "$here/download.json" > "$latest"
put "$latest" latest.json "public, max-age=300"

apt="$(mktemp -d)"
"$here/apt.sh" "$apt"
aws s3 cp "$apt/pool" "$APT_BUCKET/pool" --recursive --cache-control "public, max-age=31536000, immutable"
aws s3 cp "$apt/eolymp.asc" "$APT_BUCKET/eolymp.asc" --cache-control "public, max-age=300"
aws s3 cp "$apt/dists" "$APT_BUCKET/dists" --recursive --exclude "stable/InRelease" --cache-control "no-cache"
aws s3 cp "$apt/dists/stable/InRelease" "$APT_BUCKET/dists/stable/InRelease" --cache-control "no-cache"
