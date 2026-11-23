"""Writes extension/tools.json: the compiler and Python the Doctor installs, with their SHA-256."""
import hashlib
import json
import re
import urllib.request

GCC = "16.2.0"
PYTHON = "3.13"
WINDOWS_PYTHON = "3.13.1"
WINLIBS = r"^winlibs-x86_64-posix-seh-gcc-16\.2\.0-llvm-[\d.]+-mingw-w64ucrt-.*\.zip$"
MACOS = {"25": "tahoe", "24": "sequoia", "23": "sonoma"}
BOTTLES = ["gcc", "gmp", "isl", "libmpc", "mpfr", "zstd", "lz4", "xz"]


def get(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "eolymp-code-pin", **(headers or {})})
    with urllib.request.urlopen(request) as response:
        return response.read()


def conda(arch):
    repo = json.loads(get("https://conda.anaconda.org/conda-forge/%s/current_repodata.json" % arch))
    noarch = json.loads(get("https://conda.anaconda.org/conda-forge/noarch/current_repodata.json"))
    names = ["gcc_impl_%s", "gxx_impl_%s", "binutils_impl_%s", "ld_impl_%s", "libstdcxx-devel_%s", "libgcc-devel_%s", "sysroot_%s", "kernel-headers_%s", "libgcc", "libstdcxx", "libgomp", "libzlib", "zstd", "libsanitizer"]
    exact = {"gcc_impl": GCC, "gxx_impl": GCC, "libstdcxx-devel": GCC, "libgcc-devel": GCC, "libgcc": GCC, "libstdcxx": GCC, "libgomp": GCC, "libsanitizer": GCC, "sysroot": "2.17"}
    items = []
    for name in names:
        name = name % arch if "%s" in name else name
        wanted = exact.get(name.replace("_" + arch, ""))
        best = None
        for folder, source in ((arch, repo), ("noarch", noarch)):
            for file, package in source.get("packages.conda", {}).items():
                if package["name"] == name and (wanted is None or package["version"] == wanted or (name.startswith("sysroot") and package["version"].startswith(wanted))):
                    if best is None or package.get("timestamp", 0) > best[2].get("timestamp", 0):
                        best = (folder, file, package)
        folder, file, package = best
        items.append({"url": "https://conda.anaconda.org/conda-forge/%s/%s" % (folder, file), "sha256": package["sha256"], "type": "conda", "into": "gcc"})
    return items


def standalone_python():
    release = json.loads(get("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"))
    found = {}
    for asset in release["assets"]:
        match = re.match(r"cpython-(%s\.\d+)\+\d+-(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu)-install_only_stripped\.tar\.gz$" % re.escape(PYTHON), asset["name"])
        if match:
            system = "darwin" if "apple" in match.group(3) else "linux"
            found["%s-%s" % (system, "arm64" if match.group(2) == "aarch64" else "x64")] = {"url": asset["browser_download_url"], "sha256": asset["digest"].split(":")[1], "type": "tar.gz", "into": "."}
    return found


def clangd():
    release = json.loads(get("https://api.github.com/repos/clangd/clangd/releases/latest"))
    asset = next(a for a in release["assets"] if re.match(r"clangd-linux-[\d.]+\.zip$", a["name"]))
    return {"url": asset["browser_download_url"], "sha256": asset["digest"].split(":")[1], "type": "zip", "into": "clangd"}, "clangd/clangd_%s/bin/clangd" % release["tag_name"]


def bottles(arch):
    sets = {}
    for major, name in MACOS.items():
        key = ("arm64_" + name) if arch == "arm64" else name
        items = []
        for formula in BOTTLES:
            data = json.loads(get("https://formulae.brew.sh/api/formula/%s.json" % formula))
            files = data["bottle"]["stable"]["files"]
            if key not in files:
                items = None
                break
            items.append({"url": files[key]["url"], "sha256": files[key]["sha256"], "type": "tar.gz", "into": "brew", "bearer": "QQ=="})
        if items:
            sets[major] = items
    return sets


def main():
    python = standalone_python()
    tools = {}
    for arch, name in (("x64", "linux-64"), ("arm64", "linux-aarch64")):
        triple = ("x86_64" if arch == "x64" else "aarch64") + "-conda-linux-gnu"
        tools["linux-" + arch] = {"items": conda(name) + [python["linux-" + arch]], "cxx": "gcc/bin/%s-g++" % triple, "python": "python/bin/python3", "flags": ["-static-libstdc++", "-static-libgcc"]}
        if arch == "x64":
            item, binary = clangd()
            tools["linux-x64"]["items"].append(item)
            tools["linux-x64"]["clangd"] = binary
    for arch in ("arm64", "x64"):
        for major, items in bottles(arch).items():
            tools["darwin-%s-%s" % (arch, major)] = {"items": items + [python["darwin-" + arch]], "relocate": "brew", "cxx": "brew/gcc/%s/bin/g++-16" % GCC, "python": "python/bin/python3", "flags": ["-static-libstdc++", "-static-libgcc"], "sdk": True}
    releases = json.loads(get("https://api.github.com/repos/brechtsanders/winlibs_mingw/releases?per_page=30"))
    compiler = next(asset for release in releases for asset in release["assets"] if re.match(WINLIBS, asset["name"]))
    embedded = "https://www.python.org/ftp/python/%s/python-%s-embed-amd64.zip" % (WINDOWS_PYTHON, WINDOWS_PYTHON)
    tools["win32-x64"] = {
        "items": [
            {"url": compiler["browser_download_url"], "sha256": compiler["digest"].split(":")[1], "type": "zip", "into": "gcc"},
            {"url": embedded, "sha256": hashlib.sha256(get(embedded)).hexdigest(), "type": "zip", "into": "python"},
        ],
        "cxx": "gcc/mingw64/bin/g++.exe", "python": "python/python.exe", "clangd": "gcc/mingw64/bin/clangd.exe", "flags": [],
    }
    for key, tool in tools.items():
        tool["id"] = hashlib.sha256(json.dumps(tool, sort_keys=True).encode()).hexdigest()[:12]
    with open("extension/tools.json", "w") as file:
        json.dump(tools, file, indent=1)
    print({key: (len(tool["items"]), tool["id"]) for key, tool in tools.items()})


main()
