# Eolymp Code

An editor for competitive programming: C++ and Python with completion, a debugger, and a console to run a solution and check it against tests.

## Install

macOS and Linux:

    curl -fsSL https://downloads.eolymp.com/code/install.sh | bash

Windows, in PowerShell:

    irm https://downloads.eolymp.com/code/install.ps1 | iex

The app installs its own GCC and Python. On Intel Macs and on macOS older than 15 it uses Apple's compiler instead.

## Layout

- `app/` builds the editor from source with [VSCodium](https://github.com/VSCodium/vscodium)'s build scripts.
- `extension/` is the Eolymp Code extension.
- `editor/` holds the default settings and the list of pinned downloads.
- `l10n/` holds the Ukrainian language pack for the editor.
- `install/` holds the installer templates.
- `tests/` drives the installed app with Playwright.

## Build

    ./app/build.sh    # the editor, for this machine
    ./build.sh        # dist/: installers and release files
    EOLYMP_CODE_URL="file://$PWD/dist" bash dist/install.sh

## Test

    cd tests && npm ci && npm test

## Licences

The editor is built from [Code - OSS](https://github.com/microsoft/vscode) (MIT). `extension/codicon.ttf` is from [vscode-codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
