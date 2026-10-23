# Local regression check: mock Plink so no network connection is made.
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $projectDirectory 'tools/test-remote.ps1'
$global:SingboxManualMockCalls = [System.Collections.Generic.List[object]]::new()
$global:SingboxManualMockExitCode = 0

function plink.exe {
    $global:SingboxManualMockCalls.Add(@($args))
    $global:LASTEXITCODE = $global:SingboxManualMockExitCode
}

try {
    & $runnerPath -SshTarget root@test.example -Port 27598 -SshClient PuTTY
    if ($global:SingboxManualMockCalls.Count -ne 1) {
        throw 'Expected exactly one SSH connection'
    }
    $clientArguments = $global:SingboxManualMockCalls[0]
    $portIndex = [Array]::IndexOf($clientArguments, '-P')
    if ($portIndex -lt 0 -or $clientArguments[$portIndex + 1] -ne '27598') {
        throw 'Plink must receive uppercase -P and the selected port'
    }
    $scriptIndex = [Array]::IndexOf($clientArguments, '-m')
    if ($scriptIndex -lt 0) { throw 'Missing remote command file' }
    $remoteScriptPath = $clientArguments[$scriptIndex + 1]
    $scriptBytes = [IO.File]::ReadAllBytes($remoteScriptPath)
    if ($scriptBytes[0] -ne 115 -or $scriptBytes -contains 13) {
        throw 'Remote script must start with set and use LF without a BOM'
    }
    $scriptText = [Text.Encoding]::UTF8.GetString($scriptBytes)
    $archiveMatch = [regex]::Match($scriptText, "<<'SINGBOX_TEST_ARCHIVE'\n([A-Za-z0-9+/=]+)\nSINGBOX_TEST_ARCHIVE\n")
    if (-not $archiveMatch.Success) { throw 'Embedded archive is missing' }
    $decodedPath = $remoteScriptPath + '.tar.gz'
    [IO.File]::WriteAllBytes($decodedPath, [Convert]::FromBase64String($archiveMatch.Groups[1].Value))
    $archiveFiles = @(tar -tzf $decodedPath)
    if ($LASTEXITCODE -ne 0) { throw 'Embedded archive is invalid' }
    foreach ($archiveFile in $archiveFiles) {
        if ($archiveFile -notmatch '^(README\.md|install\.sh|check\.sh|docs/manual\.md|scripts/.*|lib/.*|tests/.*|service/.*|config/README\.md|config/server\.template\.json)$') {
            throw "Unexpected file in archive: $archiveFile"
        }
    }
    if ($archiveFiles -notcontains 'lib/platform.sh') { throw 'Platform library is missing' }
    if ($archiveFiles -notcontains 'install.sh') { throw 'One-click installer is missing' }
    if ($archiveFiles -notcontains 'docs/manual.md') { throw 'Manual is missing' }
    if ($archiveFiles -notcontains 'scripts/02-download-core.sh') { throw 'Core download script is missing' }
    if ($archiveFiles -notcontains 'scripts/03-install-core.sh') { throw 'Core install script is missing' }
    if ($archiveFiles -notcontains 'scripts/04-install-service.sh') { throw 'Service installer is missing' }
    if ($archiveFiles -notcontains 'scripts/00-reset-environment.sh') { throw 'Reset script is missing' }
    if ($archiveFiles -notcontains 'scripts/05-configure-server.sh') { throw 'Configuration script is missing' }
    if ($archiveFiles -notcontains 'scripts/06-start-service.sh') { throw 'Service start script is missing' }
    if ($archiveFiles -notcontains 'config/server.template.json') { throw 'Configuration template is missing' }
    if ($archiveFiles -notcontains 'service/sing-box.openrc') { throw 'OpenRC template is missing' }
    if ($archiveFiles -notcontains 'service/sing-box.service') { throw 'systemd template is missing' }

    & $runnerPath -SshTarget root@test.example -Port 27598 -SshClient PuTTY -PrepareOnly
    if ($global:SingboxManualMockCalls.Count -ne 1) {
        throw 'PrepareOnly must not connect'
    }

    $global:SingboxManualMockExitCode = 23
    $failurePropagated = $false
    try {
        & $runnerPath -SshTarget root@test.example -Port 27598 -SshClient PuTTY
    } catch {
        if ($_.Exception.Message -notmatch 'exit code 23') { throw }
        $failurePropagated = $true
    }
    if (-not $failurePropagated) { throw 'SSH failure was not propagated' }
    Write-Host 'PASS: one connection, Plink port, archive contents, LF encoding, prepare-only and failure handling (no network)'
} finally {
    Remove-Variable SingboxManualMockCalls, SingboxManualMockExitCode -Scope Global
}
