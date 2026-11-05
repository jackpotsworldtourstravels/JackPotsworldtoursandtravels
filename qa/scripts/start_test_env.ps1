<#
  Start the isolated QA environment (Windows PowerShell).

  Order of operations (fail-closed): load .env.qa -> SAFETY GATE -> create DB if
  missing -> alembic upgrade head (seeds) -> launch uvicorn on :8099.

  It will NOT touch any database until check_db_safety.py passes.

  Prerequisites you provide once:
    * A local PostgreSQL (this machine already runs PostgreSQL 18) OR Docker Desktop.
    * For the one-time CREATE ROLE/DATABASE step, set $env:PGADMIN_PASSWORD to your
      local postgres superuser password (used ONLY to create the throwaway jpw_qa DB,
      never stored). Skip this if the jpw_qa role+db already exist.

  Usage:
    $env:PGADMIN_PASSWORD = "<your local postgres superuser password>"
    pwsh qa/scripts/start_test_env.ps1
#>
param(
  [string]$EnvFile = "qa/.env.qa",
  [string]$PsqlDir = "C:\Program Files\PostgreSQL\18\bin",
  [string]$SuperUser = "postgres",
  [int]$Port = 8099
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $repo

if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile - copy qa/.env.qa.example to it first." }

# 1. Load .env.qa into the process environment
Get-Content $EnvFile | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object {
  $kv = $_ -split '=', 2
  if ($kv.Count -eq 2) { Set-Item -Path "env:$($kv[0].Trim())" -Value $kv[1].Trim() }
}

# 2. SAFETY GATE - abort if the DB is not a throwaway local one
python -I qa/scripts/check_db_safety.py
if ($LASTEXITCODE -ne 0) { throw "DB safety gate refused - aborting before touching any database." }

# 3. Create role + database if absent (idempotent). Needs PGADMIN_PASSWORD once.
$psql = Join-Path $PsqlDir "psql.exe"
if ($env:PGADMIN_PASSWORD) {
  $env:PGPASSWORD = $env:PGADMIN_PASSWORD
  & $psql -h localhost -U $SuperUser -d postgres -v ON_ERROR_STOP=1 -c `
    "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='jpw_qa') THEN CREATE ROLE jpw_qa LOGIN PASSWORD 'CHANGE_ME_local_only'; END IF; END `$`$;"
  $exists = (& $psql -h localhost -U $SuperUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='jpw_qa';")
  if ($exists -ne "1") { & $psql -h localhost -U $SuperUser -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE jpw_qa OWNER jpw_qa;" }
  Remove-Item env:PGPASSWORD
} else {
  Write-Host "PGADMIN_PASSWORD not set - assuming jpw_qa role+database already exist."
}

# 4. Migrations + seed (0002/0003/0027/0083 run inside 'upgrade head')
Push-Location backend
alembic upgrade head
Pop-Location

# 5. Launch the app on :8099 (no --reload; schema edits need a restart)
Write-Host "Starting uvicorn on http://127.0.0.1:$Port ..."
Push-Location backend
Start-Process -FilePath "python" -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","$Port","--no-access-log" -RedirectStandardOutput "$repo\qa\scripts\server.out.log" -RedirectStandardError "$repo\qa\scripts\server.err.log"
Pop-Location
Write-Host "Started. Health: curl http://127.0.0.1:$Port/api/health"
Write-Host "Stop with: pwsh qa/scripts/stop_test_env.ps1"
