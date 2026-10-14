# Testa o projeto em Linux DENTRO de um container:
#   1) build da imagem (Node 20 + libs do Electron + Xvfb)
#   2) todos os testes offline rodam no Linux
#   3) smoke test: o app sobe de verdade em modo headless e o /status responde
# Uso: powershell -File deploy\test-linux.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '== 1) Build da imagem Linux =='
docker build -f (Join-Path $PSScriptRoot 'Dockerfile.linux') -t linkzap-linux:test $root
if ($LASTEXITCODE -ne 0) { throw 'Build da imagem falhou' }

Write-Host ''
Write-Host '== 2) Testes offline no Linux =='
docker run --rm linkzap-linux:test npm test
if ($LASTEXITCODE -ne 0) { throw 'Testes falharam no Linux' }

Write-Host ''
Write-Host '== 3) Smoke test: app headless no Linux =='
$name = "linkzap-smoke-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
docker run --rm -d --name $name `
  -e HEADLESS=1 `
  -e LINK_HTTP_HOST=0.0.0.0 `
  -e LINK_HTTP_PORT=8123 `
  -p 18123:8123 `
  --shm-size=512m `
  linkzap-linux:test bash -c "xvfb-run -a npm run start:headless"

$ok = $false
$status = $null
$logs = @()
try {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $running = docker inspect -f '{{.State.Running}}' $name 2>$null
    if ($running -ne 'true') { break }
    try {
      $status = Invoke-RestMethod -Uri 'http://127.0.0.1:18123/status' -TimeoutSec 3
      if ($status.ok) { $ok = $true; break }
    } catch { }
  }
  $logs = @(docker logs $name 2>&1 | ForEach-Object { $_.ToString() })

  if (-not $ok) {
    Write-Host '--- logs do container ---'
    $logs | ForEach-Object { Write-Host $_ }
    throw 'Smoke test falhou: /status nao respondeu com ok=true'
  }

  Write-Host ("SMOKE OK: " + ($status | ConvertTo-Json -Compress))

  $joined = $logs -join "`n"
  if ($joined -notmatch '\[HTTP\]') { throw 'Log sem a linha [HTTP] do servidor de status' }
  if ($joined -notmatch 'DevTools listening') { throw 'Log sem o DevTools do Electron' }
  if ($joined -match 'FALHA:') { Write-Host 'ATENCAO: ha linhas FALHA nos logs do app' }

  $page = Invoke-WebRequest -Uri 'http://127.0.0.1:18123/' -TimeoutSec 5 -UseBasicParsing
  if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'Assistente do Zap') {
    throw 'Pagina de status nao respondeu como esperado'
  }
  Write-Host 'Pagina de status: OK'

  $qrCode = $null
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:18123/qr?zap=inexistente' -TimeoutSec 5 -UseBasicParsing | Out-Null
    $qrCode = 200
  } catch {
    if ($_.Exception.Response) { $qrCode = [int]$_.Exception.Response.StatusCode }
  }
  if ($qrCode -ne 404) { throw "GET /qr sem zap deveria dar 404, veio $qrCode" }
  Write-Host 'Endpoint /qr: OK (404 esperado para zap inexistente)'

  Write-Host ''
  Write-Host '--- linhas-chave do log ---'
  $logs | Select-String -Pattern '\[HTTP\]|DevTools|CONTACTS|save-zaps' | ForEach-Object { Write-Host "  $_" }
} finally {
  docker rm -f $name 2>$null | Out-Null
}

Write-Host ''
Write-Host '== TUDO OK NO LINUX =='
