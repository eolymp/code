#!/usr/bin/env bash
# Builds the signed apt repository for the .deb packages in artifacts/. Usage: apt.sh <dir>; APT_SIGNING_KEY holds the private key.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
dir="$1"

[ -z "$(ls -A "$dir" 2>/dev/null)" ] || { echo "$dir is not empty"; exit 1; }
mkdir -p "$dir/pool"
for deb in "$repo"/artifacts/eolymp-code-linux-*.deb; do
  cp "$deb" "$dir/pool/$(dpkg-deb -f "$deb" Package)_$(dpkg-deb -f "$deb" Version)_$(dpkg-deb -f "$deb" Architecture).deb"
done
cp "$here/apt/eolymp.asc" "$dir/"

cd "$dir"
for arch in amd64 arm64; do
  mkdir -p "dists/stable/main/binary-$arch"
  apt-ftparchive --arch "$arch" packages pool > "dists/stable/main/binary-$arch/Packages"
  gzip -9kn "dists/stable/main/binary-$arch/Packages"
done
release="$(apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Eolymp \
  -o APT::FTPArchive::Release::Label="Eolymp Code" \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
  -o APT::FTPArchive::Release::Components=main \
  release dists/stable)"
printf '%s\n' "$release" > dists/stable/Release

export GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
gpg --batch --yes --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --armor --detach-sign -o dists/stable/Release.gpg dists/stable/Release
