# Installs a locally built NexQ for the CURRENT USER only (no admin, no network,
# no downloads):  .\scripts\install-user.ps1 [-Build] [-Source <dir|nexq.exe>]
#
# The app is copied to %LOCALAPPDATA%\Programs\NexQ (never run from src-tauri\target,
# which any later `cargo build/test` can overwrite) and the Desktop shortcut
# 'NexQ.lnk' is created or repaired to point at that installed copy. Re-run it
# after every rebuild or `git pull`: `.\scripts\install-user.ps1 -Build`.
#
# Dot-source to reuse the functions (tests do): . .\scripts\install-user.ps1
# Never touches %APPDATA%\com.nexq.app (user data).
[CmdletBinding(SupportsShouldProcess)]
param(
    # A built release folder (containing nexq.exe and its DLLs) or the nexq.exe itself.
    # Default (empty): the repository's src-tauri\target\x86_64-pc-windows-gnu\release.
    [string]$Source = '',
    # Build first with `npx tauri build` via scripts\native-env.ps1, then install.
    [switch]$Build,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\NexQ'),
    # No shortcuts at all (cannot be combined with -StartMenu).
    [switch]$NoShortcut,
    # Also create/update a Start Menu shortcut for the current user.
    [switch]$StartMenu,
    # Reinstall even when identical, and adopt a non-empty folder NexQ did not create.
    [switch]$Force,
    [string]$CondaExe
)

$script:NexqScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:NexqRepoRoot = Split-Path -Parent $script:NexqScriptDir
if (-not $Source) { $Source = Join-Path $script:NexqRepoRoot 'src-tauri\target\x86_64-pc-windows-gnu\release' }
$script:NexqExeName = 'nexq.exe'
$script:NexqManifestName = 'nexq-install.json'
$script:NexqSelfTestNoUi = 3
$script:NexqMinExeBytes = 1MB
$script:NexqDescription = 'NexQ ' + [char]0x2014 + ' AI meeting assistant'
$script:NexqExpectedDlls = @('onnxruntime.dll', 'WebView2Loader.dll')

function Get-NexqFullPath {
    param([Parameter(Mandatory)][string]$Path)
    $unresolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $full = [System.IO.Path]::GetFullPath($unresolved)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\') }
    return $full
}

function Test-NexqPathUnder {
    # $true when $Path equals $Parent or lies inside it (case-insensitive).
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Parent)
    $p = (Get-NexqFullPath $Path).TrimEnd('\')
    $q = (Get-NexqFullPath $Parent).TrimEnd('\')
    return $p.Equals($q, [System.StringComparison]::OrdinalIgnoreCase) -or
        $p.StartsWith($q + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-NexqFileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    # Not Get-FileHash: under -WhatIf its internal path resolution is intercepted and returns nothing.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead((Get-NexqFullPath $Path))
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Invoke-NexqRetry {
    # Antivirus/indexers can hold a just-written file for a moment; retry briefly, then fail loudly.
    param([Parameter(Mandatory)][scriptblock]$Action, [int]$Attempts = 6, [int]$DelayMilliseconds = 250)
    for ($i = 1; ; $i++) {
        try { & $Action; return }
        catch {
            if ($i -ge $Attempts) { throw }
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
}

function Resolve-DesktopPath {
    # The current user's real Desktop (may be redirected, e.g. into OneDrive).
    # Override: -Override or $env:NEXQ_DESKTOP_DIR (used by tests).
    [CmdletBinding()]
    param([string]$Override)
    if (-not $Override) { $Override = $env:NEXQ_DESKTOP_DIR }
    $path = if ($Override) { $Override } else { [Environment]::GetFolderPath('Desktop') }
    if (-not $path) { throw 'Could not determine the current user''s Desktop folder.' }
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Desktop folder '$path' does not exist; refusing to create it."
    }
    return $path
}

function Resolve-StartMenuPath {
    # Current user's Start Menu\Programs. Override: -Override or $env:NEXQ_STARTMENU_DIR.
    [CmdletBinding()]
    param([string]$Override)
    if (-not $Override) { $Override = $env:NEXQ_STARTMENU_DIR }
    $path = if ($Override) { $Override } else { [Environment]::GetFolderPath('Programs') }
    if (-not $path) { throw 'Could not determine the current user''s Start Menu Programs folder.' }
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Start Menu folder '$path' does not exist; refusing to create it."
    }
    return $path
}

function Resolve-NexqSource {
    # -Source may be a release folder or the nexq.exe itself.
    param([Parameter(Mandatory)][string]$Source)
    $full = Get-NexqFullPath $Source
    if (Test-Path -LiteralPath $full -PathType Container) {
        $dir = $full
        $exe = Join-Path $full $script:NexqExeName
    }
    else {
        $dir = Split-Path -Parent $full
        $exe = $full
    }
    return [pscustomobject]@{ Directory = $dir; ExePath = $exe }
}

function Invoke-NexqSelfTest {
    # Runs `<exe> --self-test` hidden and returns its exit code. The exe is a GUI
    # binary, so a console is never attached; ProcessStartInfo (not Start-Process)
    # keeps this honest under -WhatIf. Kills only the child it started, by object.
    param([Parameter(Mandatory)][string]$ExePath, [int]$TimeoutSeconds = 30)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ExePath
    $psi.Arguments = '--self-test'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = Split-Path -Parent $ExePath
    $process = [System.Diagnostics.Process]::Start($psi)
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            throw "'$ExePath --self-test' did not finish within $TimeoutSeconds s. A build that predates --self-test ignores it and opens a window instead."
        }
        return $process.ExitCode
    }
    finally { $process.Dispose() }
}

function Test-NexqBinary {
    # Returns @{ Ok; ExitCode; Message }. -SelfTestCommand ({ param($exe) ... } -> exit code)
    # is injectable for tests.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ExePath,
        [scriptblock]$SelfTestCommand,
        [int64]$MinBytes = $script:NexqMinExeBytes
    )
    $fail = {
        param($message, $code)
        [pscustomobject]@{ Ok = $false; ExitCode = $code; Message = $message }
    }
    if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
        return (& $fail "NexQ executable not found at '$ExePath'. Build it first: .\scripts\install-user.ps1 -Build" $null)
    }
    $size = (Get-Item -LiteralPath $ExePath).Length
    if ($size -lt $MinBytes) {
        return (& $fail "'$ExePath' is only $size bytes; a real NexQ build is far larger. It is not a usable NexQ binary." $null)
    }
    if (-not $SelfTestCommand) { $SelfTestCommand = { param($exe) Invoke-NexqSelfTest -ExePath $exe } }
    try { $code = & $SelfTestCommand $ExePath }
    catch { return (& $fail "Could not run '$ExePath --self-test': $($_.Exception.Message)" $null) }
    if ($code -eq 0) {
        return [pscustomobject]@{ Ok = $true; ExitCode = 0; Message = 'self-test passed' }
    }
    if ($code -eq $script:NexqSelfTestNoUi) {
        return (& $fail ("'$ExePath' was built WITHOUT Tauri's custom-protocol feature (self-test exit 3): it has no bundled interface " +
                "and would open http://localhost:5173 and show 'localhost refused to connect / ERR_CONNECTION_REFUSED'. " +
                "Plain 'cargo build' / 'cargo test' produce such a binary (and can silently overwrite the release exe). " +
                "Rebuild with 'npx tauri build' (see docs\DEVELOPMENT.md) or run: .\scripts\install-user.ps1 -Build") $code)
    }
    $hex = if ($null -ne $code) { '0x{0:X}' -f ([int]$code) } else { 'none' }
    return (& $fail ("'$ExePath --self-test' failed with exit code $code ($hex). The build may predate --self-test, " +
            "or a runtime DLL beside the exe is missing or corrupt (0xC0000135 = DLL not found).") $code)
}

function Assert-NexqBinary {
    param([Parameter(Mandatory)][string]$ExePath, [scriptblock]$SelfTestCommand, [int64]$MinBytes = $script:NexqMinExeBytes)
    $result = Test-NexqBinary -ExePath $ExePath -SelfTestCommand $SelfTestCommand -MinBytes $MinBytes
    if (-not $result.Ok) { throw $result.Message }
}

function Test-NexqIconResource {
    # $true = the exe embeds an icon, $false = it does not, $null = could not tell.
    param([Parameter(Mandatory)][string]$ExePath)
    try {
        if (-not ('NexqInstall.IconProbe' -as [type])) {
            Add-Type -Name IconProbe -Namespace NexqInstall -MemberDefinition (
                '[DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);')
        }
        return ([NexqInstall.IconProbe]::ExtractIconEx($ExePath, -1, $null, $null, 0) -gt 0)
    }
    catch { return $null }
}

function Get-NexqVersion {
    param([Parameter(Mandatory)][string]$ExePath, [string]$RepoRoot = $script:NexqRepoRoot)
    $version = (Get-Item -LiteralPath $ExePath).VersionInfo.ProductVersion
    if ($version) { return $version.Trim() }
    $conf = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
    if (Test-Path -LiteralPath $conf -PathType Leaf) {
        $parsed = Get-Content -LiteralPath $conf -Raw | ConvertFrom-Json
        if ($parsed.version) { return [string]$parsed.version }
    }
    return 'unknown'
}

function Assert-NexqInstallDir {
    # Refuses install locations that are unsafe or would be overwritten/deleted later.
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [string]$SourceDir,
        [switch]$AllowTemp
    )
    $full = Get-NexqFullPath $InstallDir
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\') -eq $root.TrimEnd('\')) { throw "Refusing to install into a drive root ('$full')." }

    $protected = @(
        $HOME, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:ProgramFiles, $env:SystemRoot,
        (Join-Path $env:LOCALAPPDATA 'Programs'),
        [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments')
    ) | Where-Object { $_ }
    foreach ($p in $protected) {
        if (Test-NexqPathUnder -Path $p -Parent $full) {
            throw "Refusing to install into '$full': it is, or contains, the system/user folder '$p'. Use a dedicated folder such as '$(Join-Path $env:LOCALAPPDATA 'Programs\NexQ')'."
        }
    }
    foreach ($sys in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot) | Where-Object { $_ }) {
        if (Test-NexqPathUnder -Path $full -Parent $sys) {
            throw "Refusing to install into '$full': it lies inside the system folder '$sys'."
        }
    }
    $target = Join-Path $script:NexqRepoRoot 'src-tauri\target'
    if (Test-NexqPathUnder -Path $full -Parent $target) {
        throw "Refusing to install into '$full': build output under src-tauri\target can be overwritten by any cargo build/test."
    }
    foreach ($data in @((Join-Path $env:APPDATA 'com.nexq.app'), (Join-Path $env:LOCALAPPDATA 'com.nexq.app'))) {
        if (Test-NexqPathUnder -Path $full -Parent $data) { throw "Refusing to install into NexQ's user-data folder '$data'." }
    }
    if (-not $AllowTemp) {
        $temp = [System.IO.Path]::GetTempPath()
        if ((Test-NexqPathUnder -Path $full -Parent $temp) -or ($full -match '\\session-state\\')) {
            throw "Refusing to install into a temporary/session folder ('$full'); it can be deleted at any time."
        }
    }
    if ($SourceDir -and ((Test-NexqPathUnder -Path $SourceDir -Parent $full) -or (Test-NexqPathUnder -Path $full -Parent $SourceDir))) {
        throw "Source '$SourceDir' and install folder '$full' overlap; install from a separate build output folder."
    }
    return $full
}

function Get-NexqProcessesAtPath {
    # Running processes whose executable is EXACTLY $ExePath (never matched by name).
    # -ProcessLister ({ } -> objects with ProcessId, ExecutablePath) is injectable for tests.
    param([Parameter(Mandatory)][string]$ExePath, [scriptblock]$ProcessLister)
    if (-not $ProcessLister) {
        $ProcessLister = { Get-CimInstance Win32_Process -Property ProcessId, ExecutablePath }
    }
    $wanted = Get-NexqFullPath $ExePath
    return @(& $ProcessLister | Where-Object {
            $_.ExecutablePath -and
            (Get-NexqFullPath $_.ExecutablePath).Equals($wanted, [System.StringComparison]::OrdinalIgnoreCase)
        })
}

function Stop-NexqAtPath {
    # Stops NexQ only when it runs from exactly $ExePath, by process id, and waits for exit.
    # Returns the number of processes stopped. Other apps (and other NexQ copies) are left alone.
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$ExePath,
        [scriptblock]$ProcessLister,
        [scriptblock]$Stopper,
        [int]$TimeoutSeconds = 20
    )
    $ErrorActionPreference = 'Stop'
    if (-not $Stopper) {
        # Ask the window to close first (NexQ then shuts down cleanly); force only after a bound.
        $Stopper = {
            param($id)
            $p = try { [System.Diagnostics.Process]::GetProcessById($id) } catch { $null }
            if (-not $p) { return }
            if ($p.MainWindowHandle -ne 0 -and $p.CloseMainWindow() -and $p.WaitForExit(5000)) { return }
            Stop-Process -Id $id -Force -ErrorAction Stop
        }
    }
    $running = @(Get-NexqProcessesAtPath -ExePath $ExePath -ProcessLister $ProcessLister)
    if ($running.Count -eq 0) { return 0 }
    if (-not $PSCmdlet.ShouldProcess($ExePath, "Stop running NexQ (process id(s) $((@($running | ForEach-Object { $_.ProcessId })) -join ', '))")) {
        return 0
    }
    foreach ($process in $running) { & $Stopper ([int]$process.ProcessId) }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (@(Get-NexqProcessesAtPath -ExePath $ExePath -ProcessLister $ProcessLister).Count -gt 0) {
        if ((Get-Date) -gt $deadline) { throw "NexQ at '$ExePath' did not exit within $TimeoutSeconds s." }
        Start-Sleep -Milliseconds 200
    }
    return $running.Count
}

function New-NexqShortcut {
    # Creates or updates ONE .lnk (the same file every time) via WScript.Shell:
    # no wrapper, no console window.
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$ShortcutPath,
        [Parameter(Mandatory)][string]$TargetPath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$IconLocation,
        [string]$Description = $script:NexqDescription
    )
    $ErrorActionPreference = 'Stop'
    $shell = New-Object -ComObject WScript.Shell
    try {
        $existed = Test-Path -LiteralPath $ShortcutPath -PathType Leaf
        $link = $shell.CreateShortcut($ShortcutPath)
        $previousTarget = if ($existed) { $link.TargetPath } else { $null }
        if (-not $PSCmdlet.ShouldProcess($ShortcutPath, "Point shortcut at '$TargetPath'")) { return $null }
        $link.TargetPath = $TargetPath
        $link.Arguments = ''
        $link.WorkingDirectory = $WorkingDirectory
        $link.IconLocation = $IconLocation
        $link.Description = $Description
        $link.WindowStyle = 1
        $link.Save()
        $check = $shell.CreateShortcut($ShortcutPath)
        if (-not $check.TargetPath.Equals($TargetPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Shortcut '$ShortcutPath' reads back target '$($check.TargetPath)' instead of '$TargetPath'."
        }
        $action = if (-not $existed) { 'created' }
        elseif ($previousTarget -and -not $previousTarget.Equals($TargetPath, [System.StringComparison]::OrdinalIgnoreCase)) { 'repaired' }
        else { 'updated' }
        return [pscustomobject]@{
            Path           = $ShortcutPath
            Target         = $check.TargetPath
            PreviousTarget = $previousTarget
            WorkingDirectory = $check.WorkingDirectory
            IconLocation   = $check.IconLocation
            Action         = $action
        }
    }
    finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Get-NexqShortcutTarget {
    param([Parameter(Mandatory)][string]$ShortcutPath)
    $shell = New-Object -ComObject WScript.Shell
    try { return $shell.CreateShortcut($ShortcutPath).TargetPath }
    finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Get-NexqPayload {
    # nexq.exe plus every DLL beside it, with sizes and SHA-256.
    param([Parameter(Mandatory)][string]$SourceDir, [Parameter(Mandatory)][string]$ExePath, [string]$IconPath)
    $files = @(Get-Item -LiteralPath $ExePath)
    $files += @(Get-ChildItem -LiteralPath $SourceDir -Filter '*.dll' -File)
    if ($IconPath) { $files += @(Get-Item -LiteralPath $IconPath) }
    foreach ($file in $files) {
        $name = if ($file.FullName -eq (Get-Item -LiteralPath $ExePath).FullName) { $script:NexqExeName } else { $file.Name }
        [pscustomobject]@{ Name = $name; Path = $file.FullName; Bytes = $file.Length; Sha256 = (Get-NexqFileSha256 $file.FullName) }
    }
}

function Test-NexqInstallCurrent {
    # $true when every payload file is already installed byte-for-byte and a manifest exists.
    param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)]$Payload)
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $script:NexqManifestName) -PathType Leaf)) { return $false }
    foreach ($item in $Payload) {
        $installed = Join-Path $InstallDir $item.Name
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $installed).Length -ne $item.Bytes) { return $false }
        if ((Get-NexqFileSha256 $installed) -ne $item.Sha256) { return $false }
    }
    return $true
}

function Get-NexqManagedFiles {
    # Top-level files in the install folder that this installer owns.
    param([Parameter(Mandatory)][string]$InstallDir)
    if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $InstallDir -File | Where-Object {
            $_.Name -ieq $script:NexqExeName -or $_.Name -ieq $script:NexqManifestName -or
            $_.Name -ieq 'icon.ico' -or $_.Extension -ieq '.dll'
        })
}

function Install-NexqFiles {
    # Stage -> validate -> stop -> swap (previous kept for rollback) -> validate; rolls back on failure.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)]$Payload,
        [Parameter(Mandatory)][string]$Manifest,
        [scriptblock]$SelfTestCommand,
        [scriptblock]$ProcessLister,
        [scriptblock]$Stopper,
        [int64]$MinBytes = $script:NexqMinExeBytes
    )
    $ErrorActionPreference = 'Stop'
    $staging = Join-Path $InstallDir '.staging'
    $previous = Join-Path $InstallDir 'previous'
    $installedExe = Join-Path $InstallDir $script:NexqExeName
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null

    try {
        foreach ($item in $Payload) {
            $dest = Join-Path $staging $item.Name
            Copy-Item -LiteralPath $item.Path -Destination $dest -Force
            if ((Get-NexqFileSha256 $dest) -ne $item.Sha256) { throw "Copy of '$($item.Name)' to the staging folder is corrupt." }
        }
        [System.IO.File]::WriteAllText((Join-Path $staging $script:NexqManifestName), $Manifest, (New-Object System.Text.UTF8Encoding($false)))
        # Runs with the DLLs beside it: catches a missing/corrupt runtime DLL before anything is replaced.
        Assert-NexqBinary -ExePath (Join-Path $staging $script:NexqExeName) -SelfTestCommand $SelfTestCommand -MinBytes $MinBytes
    }
    catch {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }

    # Only the copy installed at exactly this path is stopped.
    [void](Stop-NexqAtPath -ExePath $installedExe -ProcessLister $ProcessLister -Stopper $Stopper)

    $moved = New-Object System.Collections.Generic.List[string]
    $placed = New-Object System.Collections.Generic.List[string]
    try {
        if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
        $old = @(Get-NexqManagedFiles -InstallDir $InstallDir)
        if ($old.Count -gt 0) {
            New-Item -ItemType Directory -Force -Path $previous | Out-Null
            foreach ($file in $old) {
                $from = $file.FullName; $to = Join-Path $previous $file.Name
                Invoke-NexqRetry { Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop }
                $moved.Add($file.Name)
            }
        }
        foreach ($file in (Get-ChildItem -LiteralPath $staging -File)) {
            $from = $file.FullName; $to = Join-Path $InstallDir $file.Name
            Invoke-NexqRetry { Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop }
            $placed.Add($file.Name)
        }
        Assert-NexqBinary -ExePath $installedExe -SelfTestCommand $SelfTestCommand -MinBytes $MinBytes
    }
    catch {
        $failure = $_
        $rollbackNote = 'The previous version was restored.'
        try {
            foreach ($name in $placed) { Remove-Item -LiteralPath (Join-Path $InstallDir $name) -Force -ErrorAction SilentlyContinue }
            foreach ($name in $moved) {
                $from = Join-Path $previous $name; $to = Join-Path $InstallDir $name
                Invoke-NexqRetry { Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop }
            }
            if ($moved.Count -eq 0) { $rollbackNote = 'Nothing had been installed before.' }
        }
        catch { $rollbackNote = "Rollback was incomplete ($($_.Exception.Message)); the old files are in '$previous'." }
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw "Install failed: $($failure.Exception.Message) $rollbackNote"
    }
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    return $moved.Count -gt 0
}

function Install-NexqApp {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$InstallDir,
        [switch]$NoShortcut,
        [switch]$StartMenu,
        [switch]$Force,
        [string]$DesktopPath,
        [string]$StartMenuPath,
        [string]$RepoRoot = $script:NexqRepoRoot,
        [scriptblock]$SelfTestCommand,
        [scriptblock]$ProcessLister,
        [scriptblock]$Stopper,
        [int64]$MinBytes = $script:NexqMinExeBytes,
        [switch]$AllowTempInstallDir
    )
    $ErrorActionPreference = 'Stop'
    if ($NoShortcut -and $StartMenu) { throw '-NoShortcut and -StartMenu cannot be combined.' }

    # 1. Validate everything before touching the install folder.
    $src = Resolve-NexqSource -Source $Source
    Assert-NexqBinary -ExePath $src.ExePath -SelfTestCommand $SelfTestCommand -MinBytes $MinBytes
    $installFull = Assert-NexqInstallDir -InstallDir $InstallDir -SourceDir $src.Directory -AllowTemp:$AllowTempInstallDir
    $installedExe = Join-Path $installFull $script:NexqExeName
    $desktopDir = if (-not $NoShortcut) { Resolve-DesktopPath -Override $DesktopPath } else { $null }
    $startMenuDir = if ($StartMenu) { Resolve-StartMenuPath -Override $StartMenuPath } else { $null }

    $manifestPath = Join-Path $installFull $script:NexqManifestName
    if ((Test-Path -LiteralPath $installFull -PathType Container) -and -not $Force -and
        -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -and
        (@(Get-ChildItem -LiteralPath $installFull -Force).Count -gt 0)) {
        throw "'$installFull' is not empty and was not created by install-user.ps1 (no $($script:NexqManifestName)). Choose another -InstallDir or pass -Force to adopt it."
    }

    # The exe embeds the icon from src-tauri\icons\icon.ico; fall back to a copied icon.ico if it does not resolve.
    $iconPath = $null
    $iconState = Test-NexqIconResource -ExePath $src.ExePath
    $iconSource = Join-Path $RepoRoot 'src-tauri\icons\icon.ico'
    if ($iconState -ne $true) {
        if (Test-Path -LiteralPath $iconSource -PathType Leaf) { $iconPath = $iconSource }
        else { Write-Warning 'Could not confirm the exe icon and icon.ico was not found; the shortcut uses the exe icon.' }
    }
    $presentDlls = @(Get-ChildItem -LiteralPath $src.Directory -Filter '*.dll' -File | ForEach-Object { $_.Name })
    foreach ($dll in $script:NexqExpectedDlls) {
        if ($presentDlls -notcontains $dll) { Write-Warning "$dll is not beside '$($src.ExePath)'; some features (local STT, WebView2) may fail." }
    }

    $payload = @(Get-NexqPayload -SourceDir $src.Directory -ExePath $src.ExePath -IconPath $iconPath)
    $exeItem = $payload | Where-Object { $_.Name -eq $script:NexqExeName }
    $version = Get-NexqVersion -ExePath $src.ExePath -RepoRoot $RepoRoot
    $iconLocation = if ($iconPath) { (Join-Path $installFull 'icon.ico') + ',0' } else { $installedExe + ',0' }

    $upToDate = (-not $Force) -and (Test-NexqInstallCurrent -InstallDir $installFull -Payload $payload)
    $result = [pscustomobject]@{
        InstallDir = $installFull; ExePath = $installedExe; Version = $version; Sha256 = $exeItem.Sha256
        Files = $payload.Count; Updated = $false; UpToDate = $upToDate; PreviousKept = $false
        Shortcuts = @(); WhatIf = $false; Source = $src.ExePath
    }

    $plan = "Install NexQ $version ($($payload.Count) files) into '$installFull'"
    if (-not $PSCmdlet.ShouldProcess($installFull, $plan)) {
        $result.WhatIf = $true
        Write-Host "WhatIf: validation passed ('$($src.ExePath)' --self-test = 0)."
        if ($upToDate) { Write-Host 'WhatIf: installed files are already identical; only shortcuts would be refreshed.' }
        else { Write-Host "WhatIf: would stop NexQ only if it runs from '$installedExe', swap files, keep the old ones in '$(Join-Path $installFull 'previous')'." }
        if ($desktopDir) { Write-Host "WhatIf: would create/update '$(Join-Path $desktopDir 'NexQ.lnk')' -> '$installedExe'." }
        if ($startMenuDir) { Write-Host "WhatIf: would create/update '$(Join-Path $startMenuDir 'NexQ.lnk')' -> '$installedExe'." }
        return $result
    }

    # 2. Replace the files (skipped when identical, so a running app is not interrupted).
    if (-not $upToDate) {
        $manifest = [ordered]@{
            product = 'NexQ'; version = $version
            buildTimeUtc = (Get-Item -LiteralPath $src.ExePath).LastWriteTimeUtc.ToString('o')
            installedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
            source = $src.ExePath; installDir = $installFull; sha256 = $exeItem.Sha256
            files = @($payload | ForEach-Object { [ordered]@{ name = $_.Name; bytes = $_.Bytes; sha256 = $_.Sha256 } })
        } | ConvertTo-Json -Depth 5
        $result.PreviousKept = [bool](Install-NexqFiles -InstallDir $installFull -Payload $payload -Manifest $manifest `
                -SelfTestCommand $SelfTestCommand -ProcessLister $ProcessLister -Stopper $Stopper -MinBytes $MinBytes)
        $result.Updated = $true
    }

    # 3. Shortcuts always point at the installed exe, repairing any that pointed elsewhere.
    $links = @()
    if ($desktopDir) { $links += (Join-Path $desktopDir 'NexQ.lnk') }
    if ($startMenuDir) { $links += (Join-Path $startMenuDir 'NexQ.lnk') }
    $shortcuts = @()
    foreach ($link in $links) {
        $shortcuts += New-NexqShortcut -ShortcutPath $link -TargetPath $installedExe -WorkingDirectory $installFull -IconLocation $iconLocation
    }
    $result.Shortcuts = $shortcuts
    return $result
}

function Invoke-NexqBuild {
    # Same build as docs\DEVELOPMENT.md 'Windows source-only builds with Conda'.
    [CmdletBinding()]
    param([string]$CondaExe)
    $ErrorActionPreference = 'Stop'
    Push-Location
    try {
        $envArgs = @{}
        if ($CondaExe) { $envArgs['CondaExe'] = $CondaExe }
        . (Join-Path $script:NexqScriptDir 'native-env.ps1') @envArgs
        & npx tauri build --no-bundle --target x86_64-pc-windows-gnu --config src-tauri\tauri.conda.conf.json '--' --locked
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE." }
    }
    finally { Pop-Location }
}

function Write-NexqSummary {
    param([Parameter(Mandatory)]$Result)
    if ($Result.WhatIf) { return }
    $state = if ($Result.Updated) { 'installed' } else { 'already up to date' }
    Write-Host "NexQ $($Result.Version) $state."
    Write-Host "  Install dir : $($Result.InstallDir)  ($($Result.Files) files)"
    Write-Host "  Executable  : $($Result.ExePath)"
    Write-Host "  SHA-256     : $($Result.Sha256)"
    Write-Host "  Built from  : $($Result.Source)"
    if ($Result.PreviousKept) { Write-Host "  Rollback    : previous version kept in '$(Join-Path $Result.InstallDir 'previous')'" }
    if ($Result.Shortcuts.Count -eq 0) { Write-Host '  Shortcuts   : none' }
    foreach ($s in $Result.Shortcuts) {
        $was = if ($s.Action -eq 'repaired') { " (was -> $($s.PreviousTarget))" } else { '' }
        Write-Host "  Shortcut    : $($s.Path) [$($s.Action)] -> $($s.Target)$was"
    }
    Write-Host '  User data (%APPDATA%\com.nexq.app) was not touched.'
}

# Dot-sourced (tests, uninstall-user.ps1): expose the functions only.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
try {
    if ($Build) {
        if ($PSCmdlet.ShouldProcess($script:NexqRepoRoot, 'Run npx tauri build (conda GNU toolchain)')) {
            Invoke-NexqBuild -CondaExe $CondaExe
        }
    }
    $result = Install-NexqApp -Source $Source -InstallDir $InstallDir -NoShortcut:$NoShortcut -StartMenu:$StartMenu -Force:$Force
    Write-NexqSummary -Result $result
    exit 0
}
catch {
    $host.UI.WriteErrorLine("install-user.ps1 failed: $($_.Exception.Message)")
    exit 1
}
