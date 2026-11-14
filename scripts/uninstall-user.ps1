# Removes the per-user NexQ install made by scripts\install-user.ps1:
#   .\scripts\uninstall-user.ps1 [-InstallDir <dir>] [-RemoveUserData] [-Force] [-WhatIf]
#
# Stops NexQ only when it runs from exactly the installed exe, removes the Desktop and
# Start Menu 'NexQ.lnk' shortcuts that point at it, then the installed files.
# User data (%APPDATA%\com.nexq.app, %LOCALAPPDATA%\com.nexq.app) is kept unless
# -RemoveUserData is given.
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\NexQ'),
    [switch]$RemoveUserData,
    # Also remove a NexQ.lnk that points elsewhere, and adopt a folder without a manifest.
    [switch]$Force
)

# Dot-sourcing install-user.ps1 re-binds its parameter names here; keep ours first.
$uninstallInstallDir = $InstallDir
$uninstallRemoveUserData = [bool]$RemoveUserData
$uninstallForce = [bool]$Force
. (Join-Path $PSScriptRoot 'install-user.ps1')

function Uninstall-NexqApp {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [switch]$RemoveUserData,
        [switch]$Force,
        [string]$DesktopPath,
        [string]$StartMenuPath,
        [string[]]$UserDataDirs = @((Join-Path $env:APPDATA 'com.nexq.app'), (Join-Path $env:LOCALAPPDATA 'com.nexq.app')),
        [scriptblock]$ProcessLister,
        [scriptblock]$Stopper,
        [switch]$AllowTempInstallDir
    )
    $ErrorActionPreference = 'Stop'
    $installFull = Assert-NexqInstallDir -InstallDir $InstallDir -AllowTemp:$AllowTempInstallDir
    $installedExe = Join-Path $installFull $script:NexqExeName
    $manifest = Join-Path $installFull $script:NexqManifestName
    $exists = Test-Path -LiteralPath $installFull -PathType Container
    if ($exists -and -not $Force -and -not (Test-Path -LiteralPath $manifest -PathType Leaf) -and
        (@(Get-ChildItem -LiteralPath $installFull -Force).Count -gt 0)) {
        throw "'$installFull' was not created by install-user.ps1 (no $($script:NexqManifestName)); nothing removed. Pass -Force to remove its NexQ files anyway."
    }
    $report = [ordered]@{ InstallDir = $installFull; Stopped = 0; ShortcutsRemoved = @(); ShortcutsKept = @(); FilesRemoved = 0; UserDataRemoved = @() }

    if ($exists) { $report.Stopped = Stop-NexqAtPath -ExePath $installedExe -ProcessLister $ProcessLister -Stopper $Stopper }

    $folders = @()
    try { $folders += Resolve-DesktopPath -Override $DesktopPath } catch { Write-Warning $_.Exception.Message }
    try { $folders += Resolve-StartMenuPath -Override $StartMenuPath } catch { Write-Warning $_.Exception.Message }
    foreach ($folder in $folders) {
        $link = Join-Path $folder 'NexQ.lnk'
        if (-not (Test-Path -LiteralPath $link -PathType Leaf)) { continue }
        $target = Get-NexqShortcutTarget -ShortcutPath $link
        $ours = $target -and $target.Equals($installedExe, [System.StringComparison]::OrdinalIgnoreCase)
        if ($ours -or $Force) {
            if ($PSCmdlet.ShouldProcess($link, 'Remove shortcut')) {
                Remove-Item -LiteralPath $link -Force
                $report.ShortcutsRemoved += $link
            }
        }
        else {
            Write-Warning "Kept '$link': it points at '$target', not at '$installedExe'. Use -Force to remove it."
            $report.ShortcutsKept += $link
        }
    }

    if ($exists -and $PSCmdlet.ShouldProcess($installFull, 'Remove installed NexQ files')) {
        foreach ($file in (Get-NexqManagedFiles -InstallDir $installFull)) {
            $victim = $file.FullName
            Invoke-NexqRetry { Remove-Item -LiteralPath $victim -Force -ErrorAction Stop }
            $report.FilesRemoved++
        }
        foreach ($name in @('previous', '.staging')) {
            $path = Join-Path $installFull $name
            if (Test-Path -LiteralPath $path) { Invoke-NexqRetry { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } }
        }
        if (@(Get-ChildItem -LiteralPath $installFull -Force).Count -eq 0) { Invoke-NexqRetry { Remove-Item -LiteralPath $installFull -Force -ErrorAction Stop } }
        else { Write-Warning "Left '$installFull' in place: it still contains files NexQ did not install." }
    }

    if ($RemoveUserData) {
        foreach ($dir in $UserDataDirs) {
            if ((Test-Path -LiteralPath $dir -PathType Container) -and $PSCmdlet.ShouldProcess($dir, 'Delete NexQ user data (database, models, recordings, settings)')) {
                Remove-Item -LiteralPath $dir -Recurse -Force
                $report.UserDataRemoved += $dir
            }
        }
    }
    return [pscustomobject]$report
}

# Dot-sourced (tests): expose the functions only.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
try {
    $outcome = Uninstall-NexqApp -InstallDir $uninstallInstallDir -RemoveUserData:$uninstallRemoveUserData -Force:$uninstallForce
    if (-not $WhatIfPreference) {
        Write-Host "NexQ removed from $($outcome.InstallDir) ($($outcome.FilesRemoved) files)."
        foreach ($s in $outcome.ShortcutsRemoved) { Write-Host "  Removed shortcut: $s" }
        foreach ($s in $outcome.ShortcutsKept) { Write-Host "  Kept shortcut   : $s" }
        if ($outcome.UserDataRemoved.Count -gt 0) { foreach ($d in $outcome.UserDataRemoved) { Write-Host "  Deleted user data: $d" } }
        else { Write-Host '  User data (%APPDATA%\com.nexq.app) was kept.' }
    }
    exit 0
}
catch {
    $host.UI.WriteErrorLine("uninstall-user.ps1 failed: $($_.Exception.Message)")
    exit 1
}
