# Dot-source from the project root: . .\scripts\native-env.ps1
# Activates the user-scoped Conda GNU toolchain described in docs/DEVELOPMENT.md.
# Performs no downloads, no installs and needs no administrator rights.
[CmdletBinding()]
param([string]$CondaExe = (Join-Path $HOME 'Miniforge3\Scripts\conda.exe'))

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CondaExe -PathType Leaf)) {
    throw "conda.exe not found at '$CondaExe'. Pass -CondaExe."
}
(& $CondaExe shell.powershell hook) | Out-String | Invoke-Expression
$nodePrefix = Join-Path (Split-Path -Parent (Split-Path -Parent $CondaExe)) 'envs\nexq'
conda activate nexq-native
# Node/npm come from the existing 'nexq' env; GNU tools stay first on PATH.
if (Test-Path $nodePrefix) { $env:PATH = "$env:PATH;$nodePrefix" }

$nativePrefix = $env:CONDA_PREFIX
$nativeBin = Join-Path $nativePrefix 'Library\bin'
$root = Split-Path -Parent $PSScriptRoot
$env:LIBCLANG_PATH = Join-Path $root 'src-tauri\target\native-tools'
New-Item -ItemType Directory -Force $env:LIBCLANG_PATH | Out-Null
if (-not (Test-Path (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))) {
    Copy-Item (Join-Path $nativeBin 'libclang-13.dll') (Join-Path $env:LIBCLANG_PATH 'libclang.dll')
}
$clangResources = (& clang -print-resource-dir).Trim()
$mingwHeaders = Join-Path $nativePrefix 'Library\ucrt64\include'
$env:BINDGEN_EXTRA_CLANG_ARGS = "--target=x86_64-pc-windows-gnu -resource-dir='$clangResources' -I'$mingwHeaders'"
$env:CMAKE_GENERATOR = 'Ninja'
$env:CMAKE_CXX_FLAGS = '-finput-charset=UTF-8'
$env:CMAKE_PROJECT_INCLUDE = Join-Path $root 'src-tauri\cmake\windows-gnu.cmake'
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }
Set-Location $root
