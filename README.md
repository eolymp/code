# Eolymp Code

An editor for competitive programming: C++ and Python with completion, a debugger, and a console to run a solution and check it against tests.

## Install

macOS: download the disk image for [Apple Silicon](https://downloads.eolymp.com/code/EolympCode-macos-arm64.dmg) or [Intel](https://downloads.eolymp.com/code/EolympCode-macos-x64.dmg) and drag Eolymp Code to Applications.

Linux: download the package for [x64](https://downloads.eolymp.com/code/EolympCode-linux-x64.deb) or [arm64](https://downloads.eolymp.com/code/EolympCode-linux-arm64.deb) and install it with `sudo apt install ./EolympCode-linux-x64.deb`. Other distributions can unpack the [x64](https://downloads.eolymp.com/code/EolympCode-linux-x64.tar.gz) or [arm64](https://downloads.eolymp.com/code/EolympCode-linux-arm64.tar.gz) archive.

Windows: download and run the [setup program](https://downloads.eolymp.com/code/EolympCode-windows-x64.exe).

The app installs its own GCC and Python. On Intel Macs and on macOS older than 15 it uses Apple's compiler and Python instead.

## Layout

- `app/` builds the editor from source with [VSCodium](https://github.com/VSCodium/vscodium)'s build scripts.
- `extension/` is the Eolymp Code extension: the problem list, tests and the console.
- `setup/` is the extension built into the app that installs the compiler and Python.
- `eolymp/` is the extension built into the app that opens problems from Eolymp and submits solutions.
- `editor/` holds the default settings and the list of pinned extensions.
- `l10n/` holds the Ukrainian language pack for the editor.
- `tests/` drives the installed app with Playwright.

## Build

    ./app/build.sh    # the editor for this machine, packaged in artifacts/

## Test

    cd tests && npm ci && npm test

`tests/unit/` checks the file handling and the program runner with Node's test runner. The rest drives the installed app with Playwright; with `EOLYMP_CODE_SOURCE=1` it loads `extension/`, `setup/` and `eolymp/` from this checkout into it.

## Licences

The editor is built from [Code - OSS](https://github.com/microsoft/vscode) (MIT). `extension/codicon.ttf` is from [vscode-codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
