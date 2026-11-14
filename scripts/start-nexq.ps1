[CmdletBinding()]
param(
    [string]$CondaExe = (Join-Path $HOME 'Miniforge3\Scripts\conda.exe'),
    [ValidateSet('debug', 'release')]
    [string]$Configuration = 'release'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot "src-tauri\target\x86_64-pc-windows-gnu\$Configuration\nexq.exe"

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Locally built NexQ was not found at '$executable'. Complete the GNU source build documented in docs\DEVELOPMENT.md first. This launcher does not download or build software."
}

if (-not (Test-Path -LiteralPath $CondaExe -PathType Leaf)) {
    throw "Conda was not found at '$CondaExe'. Supply the path to your existing conda.exe with -CondaExe."
}

$otherConfiguration = if ($Configuration -eq 'release') { 'debug' } else { 'release' }
$otherExecutable = Join-Path $projectRoot "src-tauri\target\x86_64-pc-windows-gnu\$otherConfiguration\nexq.exe"
$otherInstance = Get-CimInstance Win32_Process -Filter "Name = 'nexq.exe'" -Property ExecutablePath |
    Where-Object { $_.ExecutablePath -eq $otherExecutable }
if ($otherInstance) {
    throw "NexQ is already running from '$otherExecutable'. Quit it from the system-tray menu before switching build profiles; closing the window only hides it."
}

Push-Location $projectRoot
try {
    & $CondaExe run --no-capture-output -n nexq-native $executable
    if ($LASTEXITCODE -ne 0) {
        throw "NexQ or Conda exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
