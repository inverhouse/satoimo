# Downloads the pinned LGPL (no x264/x265) static FFmpeg build for Windows x64 and places it
# where Tauri's externalBin expects it. Run from the repo root:  powershell -File scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"
$tag = "autobuild-2026-10-07-13-07"            # BtbN/FFmpeg-Builds release used for the bundled binary
$asset = "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip" # FFmpeg n9.0.2-22-g46d8f462ee, --enable-version3 (LGPL v3)
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$tag/$asset"
$tmp = Join-Path $env:TEMP "satoimo-ffmpeg"
New-Item -ItemType Directory -Force $tmp | Out-Null
Invoke-WebRequest $url -OutFile "$tmp\ff.zip"
Expand-Archive "$tmp\ff.zip" -DestinationPath $tmp -Force
$dir = Get-ChildItem $tmp -Directory | Where-Object Name -like "ffmpeg-*" | Select-Object -First 1
New-Item -ItemType Directory -Force "src-tauri\binaries" | Out-Null
Copy-Item "$($dir.FullName)\bin\ffmpeg.exe" "src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe" -Force
& "src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe" -hide_banner -version | Select-Object -First 1
