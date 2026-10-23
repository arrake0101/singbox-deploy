# Windows 快速验证入口：选择 SSH 客户端 → 打包 → 一次连接完成上传和检查。
# 改动服务器环境的操作，放在后续编号脚本中，由你单独执行。
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^([A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$SshTarget,

    [ValidateRange(1, 65535)]
    [int]$Port = 22,

    [ValidateSet('Auto', 'PuTTY', 'OpenSSH')]
    [string]$SshClient = 'Auto',

    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'

# 外部命令失败时立即停止，避免显示误导性的“检查通过”。
function Invoke-CheckedNative {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

# 1. 检查本地工具，明确选择 Plink 或 OpenSSH。
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    throw 'Required command is unavailable: tar'
}
if ($SshClient -eq 'Auto') {
    if (Get-Command plink.exe -ErrorAction SilentlyContinue) {
        $SshClient = 'PuTTY'
    } else {
        $SshClient = 'OpenSSH'
    }
}
if ($SshClient -eq 'PuTTY') {
    if (-not (Get-Command plink.exe -ErrorAction SilentlyContinue)) {
        throw 'PuTTY client is unavailable: plink.exe'
    }
    $sshExecutable = 'plink.exe'
} else {
    $openSshCommand = Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $openSshCommand) {
        throw 'OpenSSH client is unavailable: ssh.exe'
    }
    $sshExecutable = $openSshCommand.Source
}

# 2. 准备本地文件和本次服务器测试目录。
$projectDirectory = Split-Path -Parent $PSScriptRoot
$bundleDirectory = Join-Path $projectDirectory 'generated'
New-Item -ItemType Directory -Path $bundleDirectory -Force | Out-Null
$runId = [guid]::NewGuid().ToString('N')
$archivePath = Join-Path $bundleDirectory "test-$runId.tar.gz"
$remoteDirectory = "/tmp/singbox-manual-$runId"
$remoteScriptPath = Join-Path $bundleDirectory "test-$runId.remote.sh"

# 上传清单只包含代码和说明；真实配置和凭据不在此列表中。
Invoke-CheckedNative -Executable 'tar' -Arguments @(
    '-czf', $archivePath, '-C', $projectDirectory,
    'README.md', 'install.sh', 'check.sh', 'docs/manual.md', 'scripts', 'lib', 'tests', 'service',
    'config/README.md', 'config/server.template.json'
)

# 3. 生成服务器要执行的命令。
# Base64 把压缩包变成文本，才能随同一个 SSH 请求发送，减少重复认证。
# 服务器收到后依次执行：建目录 → 还原压缩包 → 解压 → sh check.sh。
$archiveBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archivePath))
$remoteScript = @'
set -eu
umask 077
command -v base64 >/dev/null 2>&1 || { printf '%s\n' 'Missing required tool: base64' >&2; exit 1; }
work_dir='__REMOTE_DIRECTORY__'
mkdir "$work_dir"
base64 -d > "$work_dir/bundle.tar.gz" <<'SINGBOX_TEST_ARCHIVE'
__ARCHIVE_BASE64__
SINGBOX_TEST_ARCHIVE
tar -xzf "$work_dir/bundle.tar.gz" -C "$work_dir"
sh "$work_dir/check.sh"
'@
$remoteScript = $remoteScript.Replace('__REMOTE_DIRECTORY__', $remoteDirectory).Replace('__ARCHIVE_BASE64__', $archiveBase64)
$remoteScript = $remoteScript.Replace("`r`n", "`n") + "`n"
[IO.File]::WriteAllText($remoteScriptPath, $remoteScript, [Text.UTF8Encoding]::new($false))

Write-Host "Test directory: ${SshTarget}:$remoteDirectory"
if ($PrepareOnly) {
    Write-Host "Prepared remote script: $remoteScriptPath (no SSH connection)"
    return
}

# 4. 建立一次 SSH 连接，执行上面准备好的命令。
if ($SshClient -eq 'PuTTY') {
    # Plink：-P 指定端口，-m 从本地文件读取远程命令。
    Invoke-CheckedNative -Executable $sshExecutable -Arguments @(
        '-ssh', '-T', '-P', "$Port", '-m', $remoteScriptPath, $SshTarget
    )
} else {
    # OpenSSH：-p 指定端口，sh -s 从标准输入读取远程脚本。
    # 直接写入字节，避免 PowerShell 管道改变编码或换行。
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $sshExecutable
    $startInfo.Arguments = "-T -p $Port $SshTarget sh -s"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $sshProcess = [Diagnostics.Process]::new()
    $sshProcess.StartInfo = $startInfo
    try {
        if (-not $sshProcess.Start()) { throw 'Unable to start OpenSSH' }
        $payloadBytes = [Text.Encoding]::UTF8.GetBytes($remoteScript)
        $inputStream = $sshProcess.StandardInput.BaseStream
        $inputStream.Write($payloadBytes, 0, $payloadBytes.Length)
        $inputStream.Close()
        $sshProcess.WaitForExit()
        if ($sshProcess.ExitCode -ne 0) {
            throw "OpenSSH failed with exit code $($sshProcess.ExitCode)"
        }
    } finally {
        $sshProcess.Dispose()
    }
}

Write-Host 'PASS: remote checks completed'
