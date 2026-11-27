#!/usr/bin/env bash
# Publishes the language packs in l10n/ to Open VSX, skipping versions that are already there. Usage: language-packs.sh; runs with Open VSX trusted publishing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
vsix="$(mktemp -d)/pack.vsix"

for pack in "$repo"/l10n/*/; do
  id=$(node -p "const m = require('${pack}package.json'); [m.publisher, m.name, m.version].join('/')")
  if curl -sf "https://open-vsx.org/api/$id" > /dev/null; then echo "$id is already published"; continue; fi
  (cd "$pack" && npx -y @vscode/vsce@4.1.1 package --no-dependencies -o "$vsix")
  npx -y ovsx@1.4.0 publish "$vsix" --trusted-publishing
done
