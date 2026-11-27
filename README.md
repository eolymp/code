# Eolymp Code

An editor for competitive programming: C++ and Python with completion, a debugger, and a console to run a solution and check it against tests.

## Install

macOS: download the disk image for [Apple Silicon](https://downloads.eolymp.com/code/eolymp-code-macos-arm64.dmg) or [Intel](https://downloads.eolymp.com/code/eolymp-code-macos-x64.dmg) and drag Eolymp Code to Applications.

Linux: download the package for [x64](https://downloads.eolymp.com/code/eolymp-code-linux-x64.deb) or [arm64](https://downloads.eolymp.com/code/eolymp-code-linux-arm64.deb) and open it to install. Updates then arrive with the system updates. Other distributions can unpack the [x64](https://downloads.eolymp.com/code/eolymp-code-linux-x64.tar.gz) or [arm64](https://downloads.eolymp.com/code/eolymp-code-linux-arm64.tar.gz) archive.

Windows: download and run the setup program for [x64](https://downloads.eolymp.com/code/eolymp-code-windows-x64.exe) or [Arm](https://downloads.eolymp.com/code/eolymp-code-windows-arm64.exe).

The app installs its own GCC and Python. On macOS older than 15 it uses Apple's compiler and Python instead.

## Layout

- `app/` builds the editor from source with [VSCodium](https://github.com/VSCodium/vscodium)'s build scripts.
- `ext/cp/` is the Competitive Programming extension: the problem list, tests and the console. It works in any VS Code.
- `ext/eolymp/` is the Eolymp Judge extension: it signs in to Eolymp, opens its problems and submits solutions.
- `ext/core/` is the Eolymp Core extension: what makes the app, such as installing the compiler and Python and the welcome page.
- `editor/` holds the default settings and the list of pinned extensions.
- `l10n/` holds the Ukrainian and Azerbaijani language packs for the editor, published to Open VSX.
- `tests/` drives the installed app with Playwright.

## Judges

An extension adds an online judge by calling `registerJudge` on the API the Competitive Programming extension exports:

    const cp = await vscode.extensions.getExtension('eolymp.cp').activate();
    cp.registerJudge({
      id: 'example',
      label: 'Example',
      search: async (query) => [{ id, label, description }],
      load: async (id) => ({ name, url, tests: [{ input, answer }], templates: { cpp, py } }),
      submit: async (problem, { language, source }) => submissionId,
      watch: async (problem, submissionId, update, signal) => {},
    });

`problem` is `{ id, url, contest }`, kept in `.problem.json` next to the solution; `contest` is set for a problem of a contest. `language` is `cpp` or `py`. A judge without `submit` and `watch` only offers its problems.

A judge that also has contests declares `"cp": { "contests": true }` in its `package.json`, so that a search in the Contests view starts it first, and adds three functions:

      searchContests: async (query) => [contest],
      describeContest: async (id) => ({ ...contest, titles }),
      loadContest: async (id, { signIn }) => ({ ...contest, slug, problems: [{ id, name, url, tests, templates }] }),

A contest is `{ id, name, url, image, startsAt, endsAt, status, problems, participants }`, where `status` is a list of labels the judge has already worked out and translated, `[{ label, tone }]`, with `tone` one of `live`, `upcoming`, `attention`, `virtual`, `done` or `blocked`, and `problems` and `participants` are counts. `titles` are the titles of the contest's problems in order, when the user may see them; the contest page lists them. Opening a contest in the editor creates a folder for it in `~/Eolymp` with `.contest.json` and a folder for each problem, named by its letter and as many leading words of its title as fit in 20 characters (`a-two-sum`). `signIn` is set when the user opens the contest, so the judge may ask them to sign in. A problem the judge does not show yet comes as `{}` and gets a folder named by its letter with a blank solution (`a/a.cpp`); when the judge shows the problem, on opening the contest again or its folder, the folder gets the tests and the judge's template and keeps its name. Before a contest starts the judge may not tell how many problems it has, and then the contest folder stays empty until it does. Folders are never renamed, so if the judge later reorders the problems, a folder's letter may no longer match the problem's letter.

`watch` calls `update` with the state of the submission every time it changes and returns when testing is over:

    { id, label, url, message, verdict, score, maxScore, time, memory, children }

`children` are results of the same shape with `kind` (`testset` or `test`) and `index`, and may have `children` of their own. `time` is in milliseconds, `memory` in bytes. `verdict` is one of `waiting`, `testing`, `accepted`, `partial`, `skipped`, `wrong-answer`, `time-limit`, `memory-limit`, `idleness-limit`, `runtime-error`, `compilation-error`, `failed`; any other text is shown as it is.

## Toolchains

By default the extension builds with the compiler and Python named in its settings. An extension can supply them instead by calling `registerToolchain`:

    const registration = cp.registerToolchain({ cxx, python, flags, env, include, diagnose });

`cxx` and `python` are paths to the compiler and Python. `flags` are added to the compiler's flags and `env` to its environment, as long as the settings don't name another compiler. `include` sets `CPLUS_INCLUDE_PATH` when the compiler in use is not the supplied one, unless the `includePath` setting is set. `diagnose` is called when a tool is missing and the user asks to fix it. Every field is optional. A new call replaces the previous toolchain, and `registration.dispose()` removes it. An extension that supplies a toolchain declares `"cp": { "toolchain": true }` in its `package.json` and registers it as soon as it activates: the extension starts every such extension before a build, so the first build already uses the toolchain.

## Build

    ./app/build.sh    # the editor for this machine, packaged in artifacts/

## Test

    ./app/build.sh build
    cd tests && npm ci && npm test

`tests/unit/` checks the file handling and the program runner with Node's test runner. The rest drives the editor built by `./app/build.sh build` with Playwright, and loads the extensions in `ext/` from this checkout into it. Set `EOLYMP_CODE_APP` to run another build of the editor.

The first-launch test installs the compiler and Python for the others, so it runs before any of them. Once they are installed it is skipped; set `EOLYMP_CODE_FRESH_TOOLS=1` to install them afresh. A report of the last run is in `tests/playwright-report/`.

## Licences

The editor is built from [Code - OSS](https://github.com/microsoft/vscode) (MIT). `extension/codicon.ttf` is from [vscode-codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
