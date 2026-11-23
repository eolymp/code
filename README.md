# Eolymp Code

An editor for competitive programming: C++ and Python with completion, a debugger, and a console to run a solution and check it against tests.

## Install

macOS: download the disk image for [Apple Silicon](https://downloads.eolymp.com/code/EolympCode-macos-arm64.dmg) or [Intel](https://downloads.eolymp.com/code/EolympCode-macos-x64.dmg) and drag Eolymp Code to Applications.

Linux:

    curl -fsSL https://downloads.eolymp.com/code/install.sh | bash

Windows, in PowerShell:

    irm https://downloads.eolymp.com/code/install.ps1 | iex

## Layout

- `app/` builds the editor from source with [VSCodium](https://github.com/VSCodium/vscodium)'s build scripts.
- `extension/` is the Eolymp Code extension.
- `editor/` holds the default settings and the list of pinned downloads.
- `l10n/` holds the Ukrainian language pack for the editor.
- `install/` holds the installer templates.
- `tests/` drives the installed app with Playwright.

## Build

    ./app/build.sh    # the editor, for this machine; on macOS a disk image in artifacts/
    ./build.sh        # dist/: installers and release files

## Test

    cd tests && npm ci && npm test

## Licences

The editor is built from [Code - OSS](https://github.com/microsoft/vscode) (MIT). `extension/codicon.ttf` is from [vscode-codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
