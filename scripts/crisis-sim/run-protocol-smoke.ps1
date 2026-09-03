# 有界 P0 冒烟：一次性解锁 Bitwarden -> 派生 ADMIN_GATE_TOKEN -> 拉起 dev server -> 跑 crisis-sim API 冒烟。
# 只报告状态/计数/布尔值；不打印、不落盘任何密钥或会话值。真源：yixun/modelscope-token。
param([switch]$UseRunningServer)

$ErrorActionPreference = "Stop"
# 本机请求一律直连：禁止 WinINET 系统代理介入（代理/WPAD 抖动曾导致请求到不了 Next，报假 404）。
[System.Net.WebRequest]::DefaultWebProxy = $null
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bwPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Bitwarden.CLI_Microsoft.Winget.Source_8wekyb3d8bbwe\bw.exe"
$envLocalPath = Join-Path $repoRoot "app\.env.local"
$outLog = Join-Path $repoRoot "output\logs\next-smoke.log"
$errLog = Join-Path $repoRoot "output\logs\next-smoke.err.log"
$statusPath = Join-Path $repoRoot "output\logs\crisis-sim-smoke-status.json"
$smokeDir = Join-Path $repoRoot "output\logs\crisis-sim-smoke"
$hostRoot = "http://127.0.0.1:3000"
$stage = "preflight"
$reasonCode = ""
$steps = @()
try { $host.UI.RawUI.WindowTitle = "YIXUN SMOKE - 请在此窗口解锁 Bitwarden" } catch { }

function Write-SafeStatus {
  param([string]$Result, [string]$CurrentStage, [string]$Reason = "")
  $directory = Split-Path -Parent $statusPath
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  @{
    schema = "yixun/crisis-sim-smoke-status@1"
    result = $Result
    stage = $CurrentStage
    reasonCode = $Reason
    steps = $global:steps
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

function Get-BitwardenPassword {
  param(
    [Parameter(Mandatory = $true)][string]$Item,
    [Parameter(Mandatory = $true)][string]$Session
  )
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $value = @(& $bwPath get password $Item --session $Session 2>$null)
    $nativeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  $value = $value | Select-Object -First 1
  if ($nativeExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
    throw "Required Bitwarden item is unavailable: $Item"
  }
  return $value
}

function Invoke-SmokeRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Cookie,
    [Parameter(Mandatory = $true)][string]$Origin,
    [string]$JsonBody = "",
    [switch]$NoRedirect
  )
  # 传输层用 curl.exe：实测 IWR 在烟测进程中对同一 Cookie 请求被门禁 404 而 curl 同参数 200（2026-09-03 取证）。
  # 机密纪律：Cookie/Origin 走 stdin 的 --config，不进 argv、不落盘；JsonBody 非密，走临时文件。
  $bodyFile = ""
  $proc = $null
  try {
    $curlConfig = @(
      "silent"
      "show-error"
      "noproxy = `"*`""
      "max-time = 240"
      "url = `"$Url`""
      "header = `"Cookie: $Cookie`""
      "header = `"Origin: $Origin`""
      "write-out = `"\n__CURL_HTTP_CODE__%{http_code}`""
    )
    if ($NoRedirect) { $curlConfig += "max-redirs = 0" }
    if ($Method -ne "GET") {
      # curl 配置文件里反斜杠是转义符，路径必须用正斜杠（2026-09-03 实测：反斜杠路径导致 curl 配置解析失败，POST 全灭）。
      $bodyFile = (Join-Path $env:TEMP ("crisis-smoke-body-" + [guid]::NewGuid().ToString("N") + ".json")) -replace '\\', '/'
      [System.IO.File]::WriteAllText($bodyFile, $JsonBody, (New-Object System.Text.UTF8Encoding($false)))
      $curlConfig += "request = `"POST`""
      $curlConfig += "header = `"Content-Type: application/json`""
      $curlConfig += "data-binary = `"@$bodyFile`""
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "curl.exe"
    $psi.Arguments = "--config -"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # 响应体是 UTF-8（含中文）；不设编码会按系统 ANSI(GBK) 误读导致 JSON 解析失败（2026-09-03 实测）。
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write(($curlConfig -join "`n"))
    $proc.StandardInput.Close()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $status = 0
    $body = $stdout
    $markerIndex = $stdout.LastIndexOf("__CURL_HTTP_CODE__")
    if ($markerIndex -ge 0) {
      $codeText = $stdout.Substring($markerIndex + 18).Trim()
      [int]::TryParse($codeText, [ref]$status) | Out-Null
      $body = $stdout.Substring(0, $markerIndex)
      if ($body.EndsWith("`n")) { $body = $body.Substring(0, $body.Length - 1) }
    }
    if ($status -eq 0 -and $stderr) {
      return @{ Status = 0; Content = ""; Error = $stderr.Trim(); Server = ""; BodySample = "" }
    }
    $sample = $body
    if ($status -ge 400 -and $sample.Length -gt 120) { $sample = $sample.Substring(0, 120) }
    return @{ Status = $status; Content = $body; Error = ""; Server = "curl"; BodySample = $sample }
  } catch {
    return @{ Status = 0; Content = ""; Error = $_.Exception.Message; Server = "curl"; BodySample = "" }
  } finally {
    if ($proc) { $proc.Dispose() }
    if ($bodyFile -and (Test-Path -LiteralPath $bodyFile)) { Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue }
  }
}

try {
  if (-not (Test-Path -LiteralPath $bwPath -PathType Leaf)) { throw "bitwarden_cli_unavailable" }
  if (-not (Test-Path -LiteralPath $envLocalPath -PathType Leaf)) { throw "env_local_unavailable" }

  $base = ""
  foreach ($line in (Get-Content -LiteralPath $envLocalPath)) {
    if ($line -match '^NEXT_PUBLIC_ADMIN_BASE_PATH=(.*)$') {
      $base = $Matches[1].Trim().Trim('"').Trim("'")
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($base)) { throw "admin_base_path_unavailable" }
  $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if ([string]::IsNullOrWhiteSpace($npmCmd)) { throw "npm_unavailable" }

  $stage = "port_check"
  if (-not $UseRunningServer) {
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
      Start-Sleep -Milliseconds 500
    }
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
      throw "port_3000_occupied"
    }
  } elseif (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
    throw "use_running_server_but_port_3000_free"
  }

  $stage = "bitwarden_unlock"
  Write-Host "Unlock Bitwarden. Your input is hidden." -ForegroundColor Cyan
  $vaultSession = & $bwPath unlock --raw
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($vaultSession)) {
    throw "bitwarden_unlock_failed"
  }

  $stage = "vault_items"
  $clientSecret = Get-BitwardenPassword -Item "yixun/modelscope-token" -Session $vaultSession

  $stage = "derive_gate"
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  $hmac.Key = [Text.Encoding]::UTF8.GetBytes($clientSecret)
  $digest = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("yixun-admin-session-v1"))
  $gateToken = -join ($digest | ForEach-Object { $_.ToString('x2') })
  $hmac.Dispose()
  $clientSecret = $null

  $stage = "start_dev_server"
  if (-not $UseRunningServer) {
    $env:ADMIN_GATE_TOKEN = $gateToken
    New-Item -ItemType Directory -Path (Split-Path -Parent $outLog) -Force | Out-Null
    $dev = Start-Process -FilePath $npmCmd -ArgumentList @("--prefix", "app", "run", "dev") `
      -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if (-not $dev) { throw "dev_server_spawn_failed" }

    $ready = $false
    $readyDeadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $readyDeadline) {
      Start-Sleep -Seconds 3
      $probe = Invoke-SmokeRequest -Method "GET" -Url "$hostRoot/" -Cookie "yixun_admin_gate=$gateToken" -Origin $hostRoot
      if ($probe.Status -gt 0 -and $probe.Status -lt 500) { $ready = $true; break }
    }
  } else {
    # 复用已在运行的 dev server（其 ADMIN_GATE_TOKEN 必须为同派生 token；门禁自检会验证）。
    $ready = $false
    $readyDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $readyDeadline) {
      $probe = Invoke-SmokeRequest -Method "GET" -Url "$hostRoot/" -Cookie "yixun_admin_gate=$gateToken" -Origin $hostRoot
      if ($probe.Status -gt 0 -and $probe.Status -lt 500) { $ready = $true; break }
      Start-Sleep -Seconds 2
    }
  }
  $steps += @{ step = "dev_server_ready"; ok = $ready; mode = $(if ($UseRunningServer) { "reuse" } else { "spawn" }) }
  if (-not $ready) { throw "dev_server_not_ready" }

  # 门禁用已知答案自检：POST enter 表单（token 走表单体，不进 URL，避免被 Next 请求日志记录）。
  # 期望 303；若 200（表单页）说明 dev server 未采用注入的 ADMIN_GATE_TOKEN，提前失败并给出准确 stage。
  $stage = "gate_self_check"
  $gateStatus = 0
  try {
    $gwResponse = Invoke-WebRequest -UseBasicParsing -Uri "$hostRoot/$base/enter" -Method Post -Body @{ token = $gateToken } -MaximumRedirection 0 -TimeoutSec 60
    $gateStatus = [int]$gwResponse.StatusCode
  } catch {
    if ($_.Exception.Response) { try { $gateStatus = [int]$_.Exception.Response.StatusCode } catch { $gateStatus = 0 } }
  }
  $gateOk = ($gateStatus -ge 300 -and $gateStatus -lt 400)
  $steps += @{ step = "gate_self_check"; status = $gateStatus; ok = $gateOk }
  if (-not $gateOk) { throw "gate_token_rejected" }

  $stage = "smoke"
  New-Item -ItemType Directory -Path $smokeDir -Force | Out-Null
  $cookie = "yixun_admin_gate=$gateToken"
  $origin = $hostRoot

  # 冷启动预热：dev server 刚拉起时路由/门禁可能短暂未就绪，bootstrap 允许 120s 内重试到非 404。
  $bootstrap = $null
  $warmupDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $warmupDeadline) {
    $bootstrap = Invoke-SmokeRequest -Method "GET" -Url "$hostRoot/$base/api/crisis-sim" -Cookie $cookie -Origin $origin
    if ($bootstrap.Status -ne 404) { break }
    Start-Sleep -Seconds 3
  }
  if ($bootstrap.Content) {
    $bootstrap.Content | Set-Content -LiteralPath (Join-Path $smokeDir "bootstrap.json") -Encoding UTF8
  }
  $bootstrapSchema = ""
  $presetCount = 0
  $dispatchCount = 0
  if ($bootstrap.Status -eq 200 -and $bootstrap.Content) {
    $parsed = $bootstrap.Content | ConvertFrom-Json
    $bootstrapSchema = [string]$parsed.schema
    $presetCount = @($parsed.presets).Count
    $dispatchCount = @($parsed.dispatchPreviews).Count
  }
  $steps += @{ step = "get_bootstrap"; status = $bootstrap.Status; schema = $bootstrapSchema; presets = $presetCount; dispatchPreviews = $dispatchCount; server = $bootstrap.Server; bodySample = $bootstrap.BodySample; ok = ($bootstrap.Status -eq 200 -and $bootstrapSchema -eq "juchang-crisis-sim-bootstrap@1" -and $presetCount -eq 2 -and $dispatchCount -eq 2) }

  $eval1 = Invoke-SmokeRequest -Method "POST" -Url "$hostRoot/$base/api/crisis-sim" -Cookie $cookie -Origin $origin `
    -JsonBody (@{ action = "run_eval"; presetId = "2014-east-art-center" } | ConvertTo-Json)
  if ($eval1.Content) {
    $eval1.Content | Set-Content -LiteralPath (Join-Path $smokeDir "evals-2014-east-art-center.json") -Encoding UTF8
  }
  $eval1Passed = $false
  $eval1Total = 0
  $reportId2014 = ""
  if ($eval1.Status -eq 200 -and $eval1.Content) {
    $eval1Payload = $eval1.Content | ConvertFrom-Json
    $parsed = $eval1Payload.evalReport
    $eval1Passed = [bool]$parsed.allPassed
    $eval1Total = @($parsed.outcomes).Count
    $reportId2014 = [string]$eval1Payload.report.reportId
  }
  $steps += @{ step = "post_run_eval_2014"; status = $eval1.Status; allPassed = $eval1Passed; evals = $eval1Total; error = $eval1.Error; ok = ($eval1.Status -eq 200 -and $eval1Passed) }

  $eval2 = Invoke-SmokeRequest -Method "POST" -Url "$hostRoot/$base/api/crisis-sim" -Cookie $cookie -Origin $origin `
    -JsonBody (@{ action = "run_eval"; presetId = "stage-malfunction-demo" } | ConvertTo-Json)
  if ($eval2.Content) {
    $eval2.Content | Set-Content -LiteralPath (Join-Path $smokeDir "evals-stage-malfunction.json") -Encoding UTF8
  }
  $eval2Passed = $false
  $eval2Total = 0
  if ($eval2.Status -eq 200 -and $eval2.Content) {
    $parsed = ($eval2.Content | ConvertFrom-Json).evalReport
    $eval2Passed = [bool]$parsed.allPassed
    $eval2Total = @($parsed.outcomes).Count
  }
  $steps += @{ step = "post_run_eval_stage_malfunction"; status = $eval2.Status; allPassed = $eval2Passed; evals = $eval2Total; error = $eval2.Error; ok = ($eval2.Status -eq 200 -and $eval2Passed) }

  $decidedAt = (Get-Date).ToUniversalTime().ToString("o")
  $decisionBodyHash = @{
    action = "record_human_decision"
    presetId = "2014-east-art-center"
    decision = "approve_simulated_plan"
    reason = "P0 冒烟验证：人工决定收据必须保留 simulationOnly 边界，且不授予任何执行权。"
    decidedAt = $decidedAt
    runKind = "protocol_simulation"
  }
  # 回传 run_eval 拿到的 reportId，触发 route 的收据-报告一致性绑定校验
  if ($reportId2014) { $decisionBodyHash["reportId"] = $reportId2014 }
  $decisionBody = $decisionBodyHash | ConvertTo-Json
  $receipt = Invoke-SmokeRequest -Method "POST" -Url "$hostRoot/$base/api/crisis-sim" -Cookie $cookie -Origin $origin -JsonBody $decisionBody
  if ($receipt.Content) {
    $receipt.Content | Set-Content -LiteralPath (Join-Path $smokeDir "human-decision-receipt.json") -Encoding UTF8
  }
  $receiptOk = $false
  if ($receipt.Status -eq 200 -and $receipt.Content) {
    $parsed = $receipt.Content | ConvertFrom-Json
    $receiptOk = ([bool]$parsed.receipt.simulationOnly) -and (-not [bool]$parsed.receipt.executionAuthorized)
  }
  $steps += @{ step = "post_human_decision"; status = $receipt.Status; simulationOnlyTrue = $receiptOk; error = $receipt.Error; ok = $receiptOk }

  $badOrigin = Invoke-SmokeRequest -Method "POST" -Url "$hostRoot/$base/api/crisis-sim" -Cookie $cookie -Origin "http://evil.example" `
    -JsonBody (@{ action = "run_eval"; presetId = "2014-east-art-center" } | ConvertTo-Json)
  $steps += @{ step = "negative_cross_origin_post"; status = $badOrigin.Status; error = $badOrigin.Error; ok = ($badOrigin.Status -eq 403) }

  $noCookie = Invoke-SmokeRequest -Method "GET" -Url "$hostRoot/$base/api/crisis-sim" -Cookie "yixun_admin_gate=invalid" -Origin $origin
  # 隐秘门禁：无效 gate cookie 在 proxy 层即 404（不暴露后台存在），不是 401。
  $steps += @{ step = "negative_invalid_gate_cookie"; status = $noCookie.Status; ok = ($noCookie.Status -eq 404) }

  $allOk = $true
  foreach ($step in $steps) { if (-not $step.ok) { $allOk = $false } }
  if (-not $allOk) { throw "smoke_step_failed" }

  Write-SafeStatus -Result "success" -CurrentStage "complete"
  Write-Host ""
  Write-Host "Smoke finished. Dev server keeps running (PID $($dev.Id), log: output\logs\next-smoke.log)." -ForegroundColor Green
  Write-Host "All checks passed: bootstrap, 2x evals, human receipt, cross-origin reject, invalid-cookie reject." -ForegroundColor Green
} catch {
  $safeReason = ($_.Exception.Message -replace '\s+', ' ')
  if ($safeReason.Length -gt 120) { $safeReason = $safeReason.Substring(0, 120) }
  Write-SafeStatus -Result "failed" -CurrentStage $stage -Reason $safeReason
  Write-Host "Failed at stage '$stage': $safeReason" -ForegroundColor Red
  Write-Host "Dev server may still be running with the injected token; check output\logs\next-smoke.log." -ForegroundColor Yellow
} finally {
  Remove-Item Env:ADMIN_GATE_TOKEN -ErrorAction SilentlyContinue
  $vaultSession = $null
  $gateToken = $null
  $clientSecret = $null
}

Read-Host "Press Enter to close"
