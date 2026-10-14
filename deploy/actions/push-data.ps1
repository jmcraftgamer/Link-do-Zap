<#
.SYNOPSIS
  Envia as configs do app Windows (zaps/providers/trainings) para o repo
  PRIVADO de dados que o GitHub Actions usa como disco persistente.

.DESCRIPTION
  Na primeira vez clona o repo de dados em .\data (gitignored - nunca entra
  no repo publico). Nas proximas apenas copia, commita e da push. A sessao
  do WhatsApp (sessions/) NAO e copiada por padrao: o pareamento acontece no
  servidor e a sessao nasce la (com -IncludeSessions voce tambem leva a sua
  sessao local, util para migrar um vinculo ja existente).

.EXAMPLE
  .\deploy\actions\push-data.ps1 -DataRepo jmcraftgamer/linkzap-dados

.EXAMPLE
  .\deploy\actions\push-data.ps1
#>
param(
  [string]$DataRepo = "",
  [string]$Source = "$env:APPDATA\link-no-whatsapp\link-no-whatsapp",
  [switch]$IncludeSessions,
  [switch]$IncludeHistory
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dataDir = Join-Path $root "data"

if (-not (Test-Path (Join-Path $Source "zaps.json"))) {
  Write-Error "Nao achei zaps.json em '$Source'. Abra o app Windows pelo menos uma vez antes de rodar este script."
}

if (-not (Test-Path (Join-Path $dataDir ".git"))) {
  if (-not $DataRepo) {
    Write-Error "Primeira vez: informe o repo de dados. Ex: -DataRepo jmcraftgamer/linkzap-dados"
  }
  $url = if ($DataRepo -match "^https://") { $DataRepo } else { "https://github.com/$DataRepo.git" }
  Write-Host "Clonando $url -> $dataDir"
  git clone $url $dataDir
  if ($LASTEXITCODE -ne 0) { Write-Error "git clone falhou" }
}

# Configs (sempre)
foreach ($f in @("zaps.json", "providers.json", "trainings.json")) {
  $src = Join-Path $Source $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $dataDir $f) -Force
    Write-Host "  copiado $f"
  } else {
    Write-Host "  (ausente localmente: $f)" -ForegroundColor Yellow
  }
}
$trainingsSrc = Join-Path $Source "trainings"
if (Test-Path $trainingsSrc) {
  Copy-Item $trainingsSrc $dataDir -Recurse -Force
  Write-Host "  copiado trainings\"
}

if ($IncludeHistory) {
  foreach ($f in @("conversations.json", "contacts.json")) {
    $src = Join-Path $Source $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $dataDir $f) -Force; Write-Host "  copiado $f" }
  }
}

if ($IncludeSessions) {
  $sessSrc = Join-Path $Source "sessions"
  if (Test-Path $sessSrc) {
    Copy-Item $sessSrc $dataDir -Recurse -Force
    Write-Host "  copiado sessions\ (vinculo local leva junto)"
  }
} else {
  Write-Host "  sessions/ NAO copiada (padrao) - o pareamento roda no servidor." -ForegroundColor DarkGray
}

git -C $dataDir add -A
$dirty = $false
git -C $dataDir diff --cached --quiet
if ($LASTEXITCODE -ne 0) { $dirty = $true }

if (-not $dirty) {
  Write-Host "Nada novo para enviar." -ForegroundColor Green
  exit 0
}

git -C $dataDir status --short
git -C $dataDir commit -m "configs $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
git -C $dataDir push
if ($LASTEXITCODE -ne 0) { Write-Error "git push falhou (verifique DATA_PAT/permissoes no repo de dados)" }
Write-Host "Enviado! Reinicie a workflow zap-bot para recarregar as configs." -ForegroundColor Green
