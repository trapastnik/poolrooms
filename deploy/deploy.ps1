<#
  Деплой POOLROOMS на VPS по SSH (Windows / PowerShell).

  Требуется настроенный вход по SSH-КЛЮЧУ. Если ключа нет, scp/ssh спросят пароль
  в этом же окне — введёте его вы сами (это нормально).

  Примеры:
    ./deploy/deploy.ps1 -Server root@203.0.113.10
    ./deploy/deploy.ps1 -Server deploy@myhost.ru -Path /var/www/poolrooms -Port 2222
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,      # user@host
  [string]$Path = "/var/www/poolrooms",
  [int]$Port = 22
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Write-Host "== Сборка прод-бандла ==" -ForegroundColor Cyan
Push-Location $root
try { node build.mjs } finally { Pop-Location }

Write-Host "== Каталог на сервере: $Path ==" -ForegroundColor Cyan
ssh -p $Port $Server "mkdir -p '$Path'"

Write-Host "== Заливка файлов ==" -ForegroundColor Cyan
scp -P $Port "$root/game.html"          "${Server}:$Path/game.html"
scp -P $Port "$root/editor.html"        "${Server}:$Path/editor.html"
scp -P $Port "$root/deploy/index.html"  "${Server}:$Path/index.html"

Write-Host ""
Write-Host "== Готово ==" -ForegroundColor Green
Write-Host "  /            и  /game.html   — игра"
Write-Host "  /editor.html                 — редактор уровней"
Write-Host "Осталось настроить веб-сервер (deploy/Caddyfile или deploy/nginx-poolrooms.conf)."
