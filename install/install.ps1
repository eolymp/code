param(
  [string]$Root = "https://downloads.eolymp.com/code",
  [string]$Dest = "$env:LOCALAPPDATA\EolympCode",
  [string]$Work = "$env:USERPROFILE\Eolymp\practice"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

New-Item -ItemType Directory -Force $Dest, "$Dest\downloads", $Work | Out-Null
Start-Transcript -Path "$Dest\install.log" -Force | Out-Null
$started = Get-Date
$BaseUrl = "$Root/@RELEASE@"

function Step($message) { Write-Host ""; Write-Host "==> $message" -ForegroundColor Cyan }

function Fetch($url, $file) {
  curl.exe -fL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --progress-bar -o $file $url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
}

function Unpack($zip, $dir) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force $dir | Out-Null
  tar.exe -xf $zip -C $dir
  if ($LASTEXITCODE -ne 0) { throw "unpack failed: $zip" }
}

Step "Downloading the editor and its extensions"
Fetch "$BaseUrl/pins.txt" "$Dest\downloads\pins.txt"
if ((Get-FileHash -LiteralPath "$Dest\downloads\pins.txt" -Algorithm SHA256).Hash.ToLower() -ne "@PINS@") { throw "the list of downloads is damaged or was replaced" }
New-Item -ItemType Directory -Force "$Dest\downloads\pinned" | Out-Null
$pinned = @()
foreach ($line in Get-Content "$Dest\downloads\pins.txt") {
  $platform, $checksum, $url = $line -split ' '
  if ($platform -ne "win32-x64" -and $platform -ne "all") { continue }
  if ($url -notmatch "://") { $url = "$BaseUrl/$url" }
  $name = $url.Substring($url.LastIndexOf('/') + 1)
  Write-Host $name
  Fetch $url "$Dest\downloads\pinned\$name"
  $actual = (Get-FileHash -LiteralPath "$Dest\downloads\pinned\$name" -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $checksum) { throw "this download is damaged or was replaced: $url" }
  $pinned += "$Dest\downloads\pinned\$name"
}
$editor = $pinned | Where-Object { (Split-Path $_ -Leaf) -like "EolympCode-*" } | Select-Object -First 1
$extensions = @($pinned | Where-Object { $_ -like "*.vsix" })
if (-not $editor) { throw "the list of downloads is incomplete" }
$data = "$Dest\editor\data"
$kept = "$Dest\data.kept"
if (Test-Path $data) {
  if (Test-Path $kept) { Remove-Item -Recurse -Force $kept }
  Move-Item $data $kept
}
$fresh = -not (Test-Path $kept)
Unpack $editor "$Dest\editor"
if (-not $fresh) { Move-Item $kept $data }
New-Item -ItemType Directory -Force "$Dest\editor\data\user-data\User" | Out-Null



Step "Writing the editor's settings"
if ((Get-UICulture).Name -like "uk*" -and -not (Test-Path "$Dest\editor\data\argv.json")) { [IO.File]::WriteAllText("$Dest\editor\data\argv.json", '{ "locale": "uk" }') }
$target = "$Dest\editor\data\user-data\User\settings.json"
if (-not (Test-Path $target)) { Copy-Item "$Dest\downloads\pinned\settings.json" $target }

Step "Installing the extensions"
$codium = "$Dest\editor\bin\eolymp-code.cmd"
foreach ($extension in $extensions) {
  & $codium --install-extension $extension --force
  if ($LASTEXITCODE -ne 0) { throw "could not install $extension" }
}
& $codium --uninstall-extension ms-python.vscode-python-envs

Step "Creating the first problem and the shortcuts"
Copy-Item "$Dest\downloads\pinned\clang-format" "$(Split-Path $Work)\.clang-format"
$sample = "$Work\sum\sum.cpp"
if (-not (Test-Path "$Work\sum")) {
  New-Item -ItemType Directory -Force "$Work\sum" | Out-Null
  [IO.File]::WriteAllText($sample, "#include <bits/stdc++.h>`nusing namespace std;`n`nint main() {`n    int a, b;`n    cin >> a >> b;`n    cout << a + b << '\n';`n    return 0;`n}`n")
  [IO.File]::WriteAllText("$Work\sum\1.in", "12`n9`n")
  [IO.File]::WriteAllText("$Work\sum\1.answer", "21`n")
}
$shell = New-Object -ComObject WScript.Shell
foreach ($place in [Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs")) {
  $shortcut = $shell.CreateShortcut("$place\Eolymp Code.lnk")
  $shortcut.TargetPath = "$Dest\editor\Eolymp Code.exe"
  $shortcut.Arguments = "`"$Work`" `"$sample`""
  $shortcut.WorkingDirectory = $Work
  $shortcut.Save()
}

Remove-Item -Recurse -Force "$Dest\downloads"
$seconds = [int]((Get-Date) - $started).TotalSeconds
Step "Done in $seconds seconds. Starting Eolymp Code"
Stop-Transcript | Out-Null
Start-Process "$Dest\editor\Eolymp Code.exe" -ArgumentList "`"$Work`"", "`"$sample`""
