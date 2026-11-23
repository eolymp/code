"""Writes editor/pins.txt: third-party downloads with their SHA-256."""
import hashlib
import json
import re
import urllib.error
import urllib.request

CODELLDB = "v1.12.3"
PYTHON = "3.13.1"
WINLIBS = r"^winlibs-x86_64-posix-seh-gcc-[\d.]+-llvm-[\d.]+-mingw-w64ucrt-.*\.zip$"
EXTENSIONS = [
    ("ms-python", "python", "2026.10.0"),
    ("ms-python", "debugpy", "2026.6.0"),
    ("detachhead", "basedpyright", "1.40.2"),
    ("charliermarsh", "ruff", "2026.98.0"),
    ("llvm-vs-code-extensions", "vscode-clangd", "0.6.0"),
]
PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "eolymp-code-pin"})
    with urllib.request.urlopen(request) as response:
        return response.read()


def listed(url):
    return get(url).decode().split()[0].lower()


def extension(namespace, name, version, platform):
    base = "https://open-vsx.org/api/%s/%s" % (namespace, name)
    try:
        found = json.loads(get("%s/%s/%s" % (base, platform, version)))
    except urllib.error.HTTPError:
        found = json.loads(get("%s/%s" % (base, version)))
    return listed(found["files"]["sha256"]), found["files"]["download"]


def main():
    lines = []
    release = json.loads(get("https://api.github.com/repos/vadimcn/codelldb/releases/tags/" + CODELLDB))
    digests = {asset["name"]: asset["digest"] for asset in release["assets"]}
    for platform in PLATFORMS:
        name = "codelldb-%s.vsix" % platform
        url = "https://github.com/vadimcn/codelldb/releases/download/%s/%s" % (CODELLDB, name)
        lines.append((platform, digests[name].split(":")[1], url))
    for namespace, name, version in EXTENSIONS:
        for platform in PLATFORMS:
            lines.append((platform,) + extension(namespace, name, version, platform))
    releases = json.loads(get("https://api.github.com/repos/brechtsanders/winlibs_mingw/releases?per_page=15"))
    compiler = next(asset for release in releases for asset in release["assets"] if re.match(WINLIBS, asset["name"]))
    lines.append(("win32-x64", compiler["digest"].split(":")[1], compiler["browser_download_url"]))
    python = "https://www.python.org/ftp/python/%s/python-%s-embed-amd64.zip" % (PYTHON, PYTHON)
    lines.append(("win32-x64", hashlib.sha256(get(python)).hexdigest(), python))
    for line in lines:
        assert re.fullmatch(r"[0-9a-f]{64}", line[1]), line
    with open("editor/pins.txt", "w") as file:
        file.write("".join("%s %s %s\n" % line for line in lines))


main()
