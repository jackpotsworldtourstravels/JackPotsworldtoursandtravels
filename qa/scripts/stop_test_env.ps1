<#
  Stop the isolated QA environment and (optionally) drop the throwaway database.

  Usage:
    pwsh qa/scripts/stop_test_env.ps1              # stop the server only
    pwsh qa/scripts/stop_test_env.ps1 -DropDb      # stop + DROP DATABASE jpw_qa
  -DropDb needs $env:PGADMIN_PASSWORD (superuser), same as start.
#>
param(
  [switch]$DropDb,
  [string]$EnvFile = "qa/.env.qa",
  [string]$PsqlDir = "C:\Program Files\PostgreSQL\18\bin",
  [string]$SuperUser = "postgres",
  [int]$Port = 8099
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $repo

# 1. Stop the uvicorn process bound to :8099
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  Write-Host "Stopping PID $($c.OwningProcess) on port $Port"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}

# 2. Optionally drop the DB (safety-gated)
if ($DropDb) {
  if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object {
      $kv = $_ -split '=', 2; if ($kv.Count -eq 2) { Set-Item -Path "env:$($kv[0].Trim())" -Value $kv[1].Trim() }
    }
  }
  python -I qa/scripts/check_db_safety.py
  if ($LASTEXITCODE -ne 0) { throw "DB safety gate refused - NOT dropping anything." }
  if (-not $env:PGADMIN_PASSWORD) { throw "Set PGADMIN_PASSWORD to drop the database." }
  $psql = Join-Path $PsqlDir "psql.exe"
  $env:PGPASSWORD = $env:PGADMIN_PASSWORD
  & $psql -h localhost -U $SuperUser -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS jpw_qa;"
  Remove-Item env:PGPASSWORD
  Write-Host "Dropped database jpw_qa."
}
Write-Host "Done."
