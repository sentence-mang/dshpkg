<#
dshpkg L3 进程看门狗 —— Windows 启动包装。

用法：
  .\supervisor.ps1 [-Profile <name>] [-Port <number>] [-Node <node路径>]

说明：
  -Profile  要守护的 dsh profile，默认 "web"
  -Port     健康探活端口，默认 3080（未指定时也会从 dsh 启动参数解析 --port）
  -Node     可选的 node.exe 完整路径；省略时使用 PATH 中的 node
  脚本会设置 DSH_LAUNCHER 指向全局安装的 dsh 入口（若存在），
  再调用 node bin/supervisor.js 进入守护循环。
  按 Ctrl+C 结束守护：看门狗会停止 dsh 子进程并退出。

示例：
  .\supervisor.ps1
  .\supervisor.ps1 -Profile web -Port 3199
  .\supervisor.ps1 -Profile web -Node "C:\Program Files\nodejs\node.exe"
#>
[CmdletBinding()]
param(
    [string]$Profile = "web",
    [int]$Port = 3080,
    [string]$Node
)

$ErrorActionPreference = "Stop"

# Resolve the node executable (explicit -Node wins, then PATH).
if (-not $Node) {
    $Node = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $Node) {
    Write-Error "未找到 node，请安装 Node.js 或用 -Node 指定完整路径"
    exit 1
}

# Point DSH_LAUNCHER at the globally installed dsh entry when present.
if (-not $env:DSH_LAUNCHER) {
    $npmPrefix = $null
    try {
        $npmPrefix = (& npm.cmd prefix -g 2>$null | Select-Object -First 1).Trim()
    } catch {
        # npm unavailable — supervisor falls back to DSH_LAUNCHER/known prefixes.
    }
    if ($npmPrefix) {
        $launcher = Join-Path $npmPrefix "node_modules\@deepseek-ai\dsh\lib\bin.js"
        if (Test-Path $launcher) {
            $env:DSH_LAUNCHER = $launcher
        }
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$supervisor = Join-Path $scriptDir "bin\supervisor.js"

& $Node $supervisor --profile $Profile --port $Port
exit $LASTEXITCODE
