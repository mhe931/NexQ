# Self-contained tests for scripts\install-user.ps1 and uninstall-user.ps1 (no Pester).
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-user.tests.ps1
#   pwsh -NoProfile -File .\scripts\install-user.tests.ps1
# Uses only temp folders and a fake 'desktop'; never touches the real Desktop, the real
# install folder, %APPDATA%, or any running process. Exit code 0 = all passed.
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'install-user.ps1')
. (Join-Path $PSScriptRoot 'uninstall-user.ps1')

$testPassed = 0
$testFailed = 0
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('nexq-install-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function It {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body; $script:testPassed++; Write-Host "  ok   $Name" }
    catch { $script:testFailed++; Write-Host "  FAIL $Name`n       $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-True { param($Condition, [string]$Message = 'expected true') if (-not $Condition) { throw $Message } }
function Assert-Equal {
    param($Actual, $Expected, [string]$Message = '')
    if ("$Actual" -ne "$Expected") { throw "expected '$Expected' but got '$Actual'. $Message" }
}
function Assert-Throws {
    param([scriptblock]$Body, [string]$Pattern)
    $threw = $false
    try { & $Body } catch { $threw = $true; if ($_.Exception.Message -notmatch $Pattern) { throw "threw '$($_.Exception.Message)' which does not match /$Pattern/" } }
    if (-not $threw) { throw "expected an exception matching /$Pattern/" }
}
function New-TestDir {
    param([string]$Name)
    $path = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    return $path
}
function New-FakeSource {
    # A release-like folder: fake nexq.exe + DLLs (plain files; self-test is injected).
    param([string]$Name, [string]$ExeText = 'fake-exe-v1')
    $dir = New-TestDir $Name
    Set-Content -LiteralPath (Join-Path $dir 'nexq.exe') -Value $ExeText -Encoding Ascii
    foreach ($dll in @('onnxruntime.dll', 'WebView2Loader.dll', 'libgcc_s_seh-1.dll')) {
        Set-Content -LiteralPath (Join-Path $dir $dll) -Value "fake $dll" -Encoding Ascii
    }
    return $dir
}

$passSelfTest = { param($exe) 0 }
$noUiSelfTest = { param($exe) 3 }

# Fake repository root: version source + icon.ico (the fake exe embeds no icon).
$fakeRoot = New-TestDir 'repo'
New-Item -ItemType Directory -Force -Path (Join-Path $fakeRoot 'src-tauri\icons') | Out-Null
Set-Content -LiteralPath (Join-Path $fakeRoot 'src-tauri\tauri.conf.json') -Value '{ "version": "9.9.9" }' -Encoding Ascii
Set-Content -LiteralPath (Join-Path $fakeRoot 'src-tauri\icons\icon.ico') -Value 'fake-icon' -Encoding Ascii

try {
    Write-Host 'Test-NexqBinary'
    It 'refuses a binary whose --self-test exits 3 and explains the root cause' {
        $src = New-FakeSource 'src-noui'
        $r = Test-NexqBinary -ExePath (Join-Path $src 'nexq.exe') -SelfTestCommand $noUiSelfTest -MinBytes 1
        Assert-True (-not $r.Ok) 'should not be Ok'
        Assert-Equal $r.ExitCode 3
        Assert-True ($r.Message -match 'custom-protocol') 'message names custom-protocol'
        Assert-True ($r.Message -match 'ERR_CONNECTION_REFUSED') 'message names the symptom'
        Assert-True ($r.Message -match 'cargo') 'message names the cause'
        Assert-Throws { Assert-NexqBinary -ExePath (Join-Path $src 'nexq.exe') -SelfTestCommand $noUiSelfTest -MinBytes 1 } 'custom-protocol'
    }
    It 'refuses a missing exe without running anything' {
        $ran = @{ value = $false }
        $r = Test-NexqBinary -ExePath (Join-Path $testRoot 'nope\nexq.exe') -SelfTestCommand { param($e) $ran.value = $true; 0 }.GetNewClosure()
        Assert-True (-not $r.Ok) 'missing exe must be refused'
        Assert-True ($r.Message -match 'not found') 'says not found'
        Assert-True (-not $ran.value) 'self-test must not run'
    }
    It 'refuses a very small file even if its self-test "passes"' {
        $src = New-FakeSource 'src-small'
        $r = Test-NexqBinary -ExePath (Join-Path $src 'nexq.exe') -SelfTestCommand $passSelfTest
        Assert-True (-not $r.Ok) 'tiny file must be refused'
        Assert-True ($r.Message -match 'bytes') 'mentions size'
    }
    It 'accepts exit 0' {
        $src = New-FakeSource 'src-ok'
        $r = Test-NexqBinary -ExePath (Join-Path $src 'nexq.exe') -SelfTestCommand $passSelfTest -MinBytes 1
        Assert-True $r.Ok 'exit 0 should pass'
    }
    It 'refuses other exit codes and a self-test that throws' {
        $src = New-FakeSource 'src-other'
        $exe = Join-Path $src 'nexq.exe'
        $r = Test-NexqBinary -ExePath $exe -SelfTestCommand { param($e) -1073741515 } -MinBytes 1
        Assert-True (-not $r.Ok) 'DLL-not-found code must fail'
        Assert-True ($r.Message -match 'C0000135') 'hex code shown'
        $r = Test-NexqBinary -ExePath $exe -SelfTestCommand { param($e) throw 'boom' } -MinBytes 1
        Assert-True (-not $r.Ok) 'throwing self-test must fail'
    }

    Write-Host 'Desktop / Start Menu resolution'
    It 'resolves the real Desktop folder by default, honouring overrides' {
        $saved = $env:NEXQ_DESKTOP_DIR
        try {
            $env:NEXQ_DESKTOP_DIR = $null
            $expected = [Environment]::GetFolderPath('Desktop')
            if (Test-Path -LiteralPath $expected -PathType Container) {
                Assert-Equal (Resolve-DesktopPath) $expected
            }
            $fake = New-TestDir 'desktop-a'
            Assert-Equal (Resolve-DesktopPath -Override $fake) $fake
            $env:NEXQ_DESKTOP_DIR = (New-TestDir 'desktop-env')
            Assert-Equal (Resolve-DesktopPath) (Join-Path $testRoot 'desktop-env')
            Assert-Throws { Resolve-DesktopPath -Override (Join-Path $testRoot 'missing-desktop') } 'does not exist'
            Assert-True (-not (Test-Path (Join-Path $testRoot 'missing-desktop'))) 'must not create the folder'
        }
        finally { $env:NEXQ_DESKTOP_DIR = $saved }
    }
    It 'resolves the Start Menu Programs folder with an override' {
        $fake = New-TestDir 'startmenu'
        Assert-Equal (Resolve-StartMenuPath -Override $fake) $fake
        Assert-True ([Environment]::GetFolderPath('Programs')) 'real Programs folder is known'
    }

    Write-Host 'New-NexqShortcut'
    It 'creates the shortcut with the required properties' {
        $desktop = New-TestDir 'desktop-b'
        $dir = New-TestDir 'inst-one'
        $lnk = Join-Path $desktop 'NexQ.lnk'
        $r = New-NexqShortcut -ShortcutPath $lnk -TargetPath (Join-Path $dir 'nexq.exe') -WorkingDirectory $dir -IconLocation ((Join-Path $dir 'nexq.exe') + ',0')
        Assert-Equal $r.Action 'created'
        $shell = New-Object -ComObject WScript.Shell
        $l = $shell.CreateShortcut($lnk)
        Assert-Equal $l.TargetPath (Join-Path $dir 'nexq.exe')
        Assert-Equal $l.WorkingDirectory $dir
        Assert-Equal $l.Arguments ''
        Assert-Equal $l.WindowStyle 1
        Assert-Equal $l.Description $script:NexqDescription
        Assert-True ($l.IconLocation -like '*nexq.exe,0') "icon is '$($l.IconLocation)'"
        Assert-True ($l.Description.Contains([string][char]0x2014)) 'description keeps the em dash'
    }
    It 're-creating for a different InstallDir updates the SAME .lnk' {
        $desktop = New-TestDir 'desktop-c'
        $lnk = Join-Path $desktop 'NexQ.lnk'
        $dirA = New-TestDir 'inst-a'
        $dirB = New-TestDir 'inst-b'
        [void](New-NexqShortcut -ShortcutPath $lnk -TargetPath (Join-Path $dirA 'nexq.exe') -WorkingDirectory $dirA -IconLocation "$dirA\nexq.exe,0")
        $r = New-NexqShortcut -ShortcutPath $lnk -TargetPath (Join-Path $dirB 'nexq.exe') -WorkingDirectory $dirB -IconLocation "$dirB\nexq.exe,0"
        Assert-Equal $r.Action 'repaired'
        Assert-Equal $r.PreviousTarget (Join-Path $dirA 'nexq.exe')
        Assert-Equal (Get-NexqShortcutTarget $lnk) (Join-Path $dirB 'nexq.exe')
        Assert-Equal @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk').Count 1
        $again = New-NexqShortcut -ShortcutPath $lnk -TargetPath (Join-Path $dirB 'nexq.exe') -WorkingDirectory $dirB -IconLocation "$dirB\nexq.exe,0"
        Assert-Equal $again.Action 'updated'
    }
    It '-WhatIf creates nothing' {
        $desktop = New-TestDir 'desktop-whatif'
        $r = New-NexqShortcut -ShortcutPath (Join-Path $desktop 'NexQ.lnk') -TargetPath 'C:\x\nexq.exe' -WorkingDirectory 'C:\x' -IconLocation 'C:\x\nexq.exe,0' -WhatIf
        Assert-True ($null -eq $r) 'returns nothing'
        Assert-True (-not (Test-Path (Join-Path $desktop 'NexQ.lnk'))) 'no file'
    }

    Write-Host 'Stop-NexqAtPath'
    It 'stops only processes at the exact installed path, by id' {
        $target = Join-Path $testRoot 'inst-stop\nexq.exe'
        $state = @{
            procs   = @(
                [pscustomobject]@{ ProcessId = 101; ExecutablePath = $target },
                [pscustomobject]@{ ProcessId = 102; ExecutablePath = 'C:\repo\src-tauri\target\x86_64-pc-windows-gnu\release\nexq.exe' },
                [pscustomobject]@{ ProcessId = 103; ExecutablePath = 'C:\Windows\notepad.exe' },
                [pscustomobject]@{ ProcessId = 104; ExecutablePath = $target.ToUpperInvariant() },
                [pscustomobject]@{ ProcessId = 105; ExecutablePath = $null }
            )
            stopped = @()
        }
        $lister = { $state.procs | ForEach-Object { $_ } }.GetNewClosure()
        $stopper = { param($id) $state.stopped += $id; $state.procs = @($state.procs | Where-Object { $_.ProcessId -ne $id }) }.GetNewClosure()
        $count = Stop-NexqAtPath -ExePath $target -ProcessLister $lister -Stopper $stopper
        Assert-Equal $count 2
        Assert-Equal (($state.stopped | Sort-Object) -join ',') '101,104'
        Assert-Equal (($state.procs | ForEach-Object { $_.ProcessId }) -join ',') '102,103,105'
    }
    It 'does nothing when no process runs from that path' {
        $state = @{ stopped = @() }
        $lister = { [pscustomobject]@{ ProcessId = 7; ExecutablePath = 'C:\other\nexq.exe' } }
        $stopper = { param($id) $state.stopped += $id }.GetNewClosure()
        Assert-Equal (Stop-NexqAtPath -ExePath 'C:\mine\nexq.exe' -ProcessLister $lister -Stopper $stopper) 0
        Assert-Equal $state.stopped.Count 0
    }
    It 'fails clearly if the process does not exit' {
        $lister = { [pscustomobject]@{ ProcessId = 9; ExecutablePath = 'C:\mine\nexq.exe' } }
        Assert-Throws { Stop-NexqAtPath -ExePath 'C:\mine\nexq.exe' -ProcessLister $lister -Stopper { param($id) } -TimeoutSeconds 1 } 'did not exit'
    }
    It '-WhatIf stops nothing' {
        $state = @{ stopped = @() }
        $lister = { [pscustomobject]@{ ProcessId = 9; ExecutablePath = 'C:\mine\nexq.exe' } }
        $stopper = { param($id) $state.stopped += $id }.GetNewClosure()
        [void](Stop-NexqAtPath -ExePath 'C:\mine\nexq.exe' -ProcessLister $lister -Stopper $stopper -WhatIf)
        Assert-Equal $state.stopped.Count 0
    }
    It 'the scripts never stop or look up processes by name' {
        $forbidden = @('Get-Process', 'taskkill', 'taskkill.exe', 'pkill', 'killall', 'Stop-Service', 'wmic', 'wmic.exe')
        foreach ($file in @('install-user.ps1', 'uninstall-user.ps1')) {
            $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$null, [ref]$errors)
            Assert-Equal @($errors).Count 0 "$file parses"
            $commands = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
            foreach ($command in $commands) {
                $name = $command.GetCommandName()
                Assert-True ($forbidden -notcontains $name) "$file uses forbidden command $name"
                if ($name -eq 'Stop-Process') {
                    $names = @($command.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName })
                    Assert-True ($names -contains 'Id') "$file Stop-Process without -Id"
                    Assert-True ($names -notcontains 'Name') "$file Stop-Process -Name"
                }
            }
        }
    }

    Write-Host 'Assert-NexqInstallDir'
    It 'refuses unsafe install folders' {
        Assert-Throws { Assert-NexqInstallDir -InstallDir 'C:\' } 'drive root'
        Assert-Throws { Assert-NexqInstallDir -InstallDir $HOME } 'contains'
        Assert-Throws { Assert-NexqInstallDir -InstallDir (Join-Path $env:LOCALAPPDATA 'Programs') } 'contains'
        Assert-Throws { Assert-NexqInstallDir -InstallDir (Join-Path $script:NexqRepoRoot 'src-tauri\target\release') } 'overwritten'
        Assert-Throws { Assert-NexqInstallDir -InstallDir (Join-Path $env:APPDATA 'com.nexq.app\bin') } 'user-data'
        Assert-Throws { Assert-NexqInstallDir -InstallDir (Join-Path $testRoot 'tmp-inst') } 'temporary'
        Assert-Throws { Assert-NexqInstallDir -InstallDir (Join-Path $env:TEMP 'x\.copilot\session-state\abc\NexQ') } 'temporary|session'
        Assert-Throws { Assert-NexqInstallDir -InstallDir (Join-Path $testRoot 'src-x') -SourceDir (Join-Path $testRoot 'src-x\release') -AllowTemp } 'overlap'
    }
    It 'accepts the default install folder' {
        $default = Join-Path $env:LOCALAPPDATA 'Programs\NexQ'
        Assert-Equal (Assert-NexqInstallDir -InstallDir $default) $default
    }

    Write-Host 'Icon probe'
    It 'recognises an exe with an embedded icon and a file without one' {
        $notepad = Join-Path $env:SystemRoot 'System32\notepad.exe'
        if (Test-Path $notepad) { Assert-True ((Test-NexqIconResource -ExePath $notepad) -eq $true) 'notepad has an icon' }
        $src = New-FakeSource 'src-icon'
        Assert-True ((Test-NexqIconResource -ExePath (Join-Path $src 'nexq.exe')) -ne $true) 'fake exe has no icon'
    }

    Write-Host 'Install-NexqApp (fake source)'
    $desktop = New-TestDir 'e2e-desktop'
    $installDir = Join-Path $testRoot 'e2e-install'
    $common = @{ InstallDir = $installDir; DesktopPath = $desktop; RepoRoot = $fakeRoot; MinBytes = 1; AllowTempInstallDir = $true; ProcessLister = { @() } }
    $lnkPath = Join-Path $desktop 'NexQ.lnk'

    It 'refuses a no-UI build before touching the install folder or desktop' {
        $src = New-FakeSource 'e2e-src-noui'
        Assert-Throws { Install-NexqApp -Source $src -SelfTestCommand $noUiSelfTest @common } 'custom-protocol'
        Assert-True (-not (Test-Path $installDir)) 'install folder untouched'
        Assert-True (-not (Test-Path $lnkPath)) 'no shortcut'
    }
    It 'refuses a missing source exe' {
        Assert-Throws { Install-NexqApp -Source (Join-Path $testRoot 'no-such-folder') -SelfTestCommand $passSelfTest @common } 'not found'
        Assert-True (-not (Test-Path $installDir)) 'install folder untouched'
    }
    It '-WhatIf validates but writes nothing' {
        $src = New-FakeSource 'e2e-src-whatif'
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @common -WhatIf
        Assert-True $r.WhatIf 'reports WhatIf'
        Assert-True (-not (Test-Path $installDir)) 'no install folder'
        Assert-True (-not (Test-Path $lnkPath)) 'no shortcut'
    }
    It 'installs exe + all DLLs + manifest + icon and creates the shortcut' {
        $src = New-FakeSource 'e2e-src-1'
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @common
        Assert-True $r.Updated 'files installed'
        foreach ($f in @('nexq.exe', 'onnxruntime.dll', 'WebView2Loader.dll', 'libgcc_s_seh-1.dll', 'icon.ico', 'nexq-install.json')) {
            Assert-True (Test-Path (Join-Path $installDir $f)) "$f installed"
        }
        $m = Get-Content -LiteralPath (Join-Path $installDir 'nexq-install.json') -Raw | ConvertFrom-Json
        Assert-Equal $m.version '9.9.9'
        Assert-Equal $m.sha256 (Get-FileHash (Join-Path $src 'nexq.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-Equal $m.source (Join-Path $src 'nexq.exe')
        Assert-True ($m.buildTimeUtc) 'build time recorded'
        Assert-True (-not (Test-Path (Join-Path $installDir '.staging'))) 'staging removed'
        Assert-Equal (Get-NexqShortcutTarget $lnkPath) (Join-Path $installDir 'nexq.exe')
        $l = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
        Assert-Equal $l.WorkingDirectory $installDir
        Assert-True ($l.IconLocation -like '*icon.ico,0') "falls back to icon.ico (got '$($l.IconLocation)')"
    }
    It 're-running with identical files is a no-op that keeps the same shortcut' {
        $src = Join-Path $testRoot 'e2e-src-1'
        $before = (Get-Item (Join-Path $installDir 'nexq.exe')).LastWriteTimeUtc
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @common
        Assert-True $r.UpToDate 'up to date'
        Assert-True (-not $r.Updated) 'not replaced'
        Assert-Equal (Get-Item (Join-Path $installDir 'nexq.exe')).LastWriteTimeUtc $before
        Assert-Equal @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk').Count 1
    }
    It 'an update keeps the previous version and repairs a shortcut pointing elsewhere' {
        $src = New-FakeSource 'e2e-src-2' -ExeText 'fake-exe-v2'
        $stale = New-TestDir 'obsolete'
        [void](New-NexqShortcut -ShortcutPath $lnkPath -TargetPath (Join-Path $stale 'nexq.exe') -WorkingDirectory $stale -IconLocation "$stale\nexq.exe,0")
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @common
        Assert-True $r.Updated 'updated'
        Assert-True $r.PreviousKept 'previous kept'
        Assert-Equal ((Get-Content (Join-Path $installDir 'nexq.exe')) -join '') 'fake-exe-v2'
        Assert-Equal ((Get-Content (Join-Path $installDir 'previous\nexq.exe')) -join '') 'fake-exe-v1'
        Assert-Equal $r.Shortcuts[0].Action 'repaired'
        Assert-Equal (Get-NexqShortcutTarget $lnkPath) (Join-Path $installDir 'nexq.exe')
        Assert-Equal @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk').Count 1
    }
    It 'rolls back when the installed copy fails its final self-test' {
        $src = New-FakeSource 'e2e-src-3' -ExeText 'fake-exe-v3'
        $selfTest = { param($exe) if ($exe -like '*e2e-install\nexq.exe') { 3 } else { 0 } }
        Assert-Throws { Install-NexqApp -Source $src -SelfTestCommand $selfTest @common } 'previous version was restored'
        Assert-Equal ((Get-Content (Join-Path $installDir 'nexq.exe')) -join '') 'fake-exe-v2'
        Assert-True (Test-Path (Join-Path $installDir 'onnxruntime.dll')) 'dlls restored'
        Assert-True (Test-Path (Join-Path $installDir 'nexq-install.json')) 'manifest restored'
        Assert-True (-not (Test-Path (Join-Path $installDir '.staging'))) 'staging removed'
    }
    It 'a staged copy that fails its self-test is never swapped in' {
        $src = New-FakeSource 'e2e-src-4' -ExeText 'fake-exe-v4'
        $selfTest = { param($exe) if ($exe -like '*.staging*') { -1073741515 } else { 0 } }
        Assert-Throws { Install-NexqApp -Source $src -SelfTestCommand $selfTest @common } 'self-test'
        Assert-Equal ((Get-Content (Join-Path $installDir 'nexq.exe')) -join '') 'fake-exe-v2'
    }
    It 'a different InstallDir updates the same desktop .lnk' {
        $src = Join-Path $testRoot 'e2e-src-2'
        $other = @{} + $common
        $other.InstallDir = Join-Path $testRoot 'e2e-install-b'
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @other
        Assert-Equal $r.Shortcuts[0].Action 'repaired'
        Assert-Equal (Get-NexqShortcutTarget $lnkPath) (Join-Path $other.InstallDir 'nexq.exe')
        Assert-Equal @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk').Count 1
    }
    It 'only stops the installed copy during an update' {
        $src = New-FakeSource 'e2e-src-5' -ExeText 'fake-exe-v5'
        $installedExe = Join-Path $installDir 'nexq.exe'
        $state = @{
            procs   = @(
                [pscustomobject]@{ ProcessId = 11; ExecutablePath = $installedExe },
                [pscustomobject]@{ ProcessId = 12; ExecutablePath = (Join-Path $src 'nexq.exe') }
            )
            stopped = @()
        }
        $args2 = @{} + $common
        $args2.ProcessLister = { $state.procs | ForEach-Object { $_ } }.GetNewClosure()
        $args2.Stopper = { param($id) $state.stopped += $id; $state.procs = @($state.procs | Where-Object { $_.ProcessId -ne $id }) }.GetNewClosure()
        $null = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @args2
        Assert-Equal ($state.stopped -join ',') '11'
    }
    It 'refuses to adopt a non-empty folder it did not create (unless -Force)' {
        $src = New-FakeSource 'e2e-src-6'
        $foreign = New-TestDir 'e2e-foreign'
        Set-Content -LiteralPath (Join-Path $foreign 'notes.txt') -Value 'keep me' -Encoding Ascii
        $args3 = @{} + $common
        $args3.InstallDir = $foreign
        Assert-Throws { Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @args3 } 'not empty'
        $null = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @args3 -Force -NoShortcut
        Assert-True (Test-Path (Join-Path $foreign 'notes.txt')) 'unrelated file untouched'
        Assert-True (Test-Path (Join-Path $foreign 'nexq.exe')) 'installed with -Force'
    }
    It '-NoShortcut leaves the desktop alone and conflicts with -StartMenu' {
        $src = New-FakeSource 'e2e-src-7'
        $freshDesktop = New-TestDir 'e2e-desktop-none'
        $args4 = @{} + $common
        $args4.InstallDir = Join-Path $testRoot 'e2e-install-c'
        $args4.DesktopPath = $freshDesktop
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @args4 -NoShortcut
        Assert-Equal @(Get-ChildItem -LiteralPath $freshDesktop).Count 0
        Assert-Equal $r.Shortcuts.Count 0
        Assert-Throws { Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @args4 -NoShortcut -StartMenu } 'cannot be combined'
    }
    It '-StartMenu creates a second shortcut in the (fake) Programs folder' {
        $src = Join-Path $testRoot 'e2e-src-2'
        $programs = New-TestDir 'e2e-programs'
        $args5 = @{} + $common
        $args5.InstallDir = Join-Path $testRoot 'e2e-install-d'
        $args5.StartMenuPath = $programs
        $r = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @args5 -StartMenu
        Assert-Equal $r.Shortcuts.Count 2
        Assert-Equal (Get-NexqShortcutTarget (Join-Path $programs 'NexQ.lnk')) (Join-Path $args5.InstallDir 'nexq.exe')
    }

    Write-Host 'Uninstall-NexqApp (fake install)'
    It 'removes shortcut + files, keeps user data unless -RemoveUserData' {
        $src = New-FakeSource 'un-src'
        $unDesktop = New-TestDir 'un-desktop'
        $unInstall = Join-Path $testRoot 'un-install'
        $unData = New-TestDir 'un-userdata'
        Set-Content -LiteralPath (Join-Path $unData 'nexq.db') -Value 'db' -Encoding Ascii
        $unArgs = @{ InstallDir = $unInstall; DesktopPath = $unDesktop; RepoRoot = $fakeRoot; MinBytes = 1; AllowTempInstallDir = $true; ProcessLister = { @() } }
        $null = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @unArgs
        $foreignLink = Join-Path $unDesktop 'Other.lnk'
        $startMenu = New-TestDir 'un-programs'
        [void](New-NexqShortcut -ShortcutPath (Join-Path $startMenu 'NexQ.lnk') -TargetPath 'C:\elsewhere\nexq.exe' -WorkingDirectory 'C:\elsewhere' -IconLocation 'C:\elsewhere\nexq.exe,0')

        $r = Uninstall-NexqApp -InstallDir $unInstall -DesktopPath $unDesktop -StartMenuPath $startMenu -UserDataDirs @($unData) -ProcessLister { @() } -AllowTempInstallDir
        Assert-True (-not (Test-Path (Join-Path $unDesktop 'NexQ.lnk'))) 'desktop shortcut removed'
        Assert-True (Test-Path (Join-Path $startMenu 'NexQ.lnk')) 'shortcut pointing elsewhere is kept without -Force'
        Assert-True (-not (Test-Path $unInstall)) 'install folder removed'
        Assert-True (Test-Path (Join-Path $unData 'nexq.db')) 'user data kept'
        Assert-Equal $r.UserDataRemoved.Count 0

        $r = Uninstall-NexqApp -InstallDir $unInstall -DesktopPath $unDesktop -StartMenuPath $startMenu -UserDataDirs @($unData) -ProcessLister { @() } -AllowTempInstallDir -RemoveUserData -Force
        Assert-True (-not (Test-Path (Join-Path $startMenu 'NexQ.lnk'))) '-Force removes it'
        Assert-True (-not (Test-Path $unData)) 'user data removed on request'
    }
    It 'uninstall -WhatIf removes nothing' {
        $src = New-FakeSource 'un2-src'
        $unDesktop = New-TestDir 'un2-desktop'
        $unInstall = Join-Path $testRoot 'un2-install'
        $unArgs = @{ InstallDir = $unInstall; DesktopPath = $unDesktop; RepoRoot = $fakeRoot; MinBytes = 1; AllowTempInstallDir = $true; ProcessLister = { @() } }
        $null = Install-NexqApp -Source $src -SelfTestCommand $passSelfTest @unArgs
        $null = Uninstall-NexqApp -InstallDir $unInstall -DesktopPath $unDesktop -StartMenuPath (New-TestDir 'un2-programs') -ProcessLister { @() } -AllowTempInstallDir -WhatIf
        Assert-True (Test-Path (Join-Path $unDesktop 'NexQ.lnk')) 'shortcut kept'
        Assert-True (Test-Path (Join-Path $unInstall 'nexq.exe')) 'files kept'
    }

    Write-Host 'Repository hygiene'
    It 'the scripts are ASCII-only with LF line endings' {
        foreach ($file in @('install-user.ps1', 'uninstall-user.ps1', 'install-user.tests.ps1')) {
            $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $file))
            Assert-True (-not ($bytes | Where-Object { $_ -gt 127 } | Select-Object -First 1)) "$file has non-ASCII bytes"
            Assert-True (-not ($bytes -contains 13)) "$file has CR characters"
        }
    }
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "$testPassed passed, $testFailed failed."
if ($testFailed -gt 0) { exit 1 }
exit 0
