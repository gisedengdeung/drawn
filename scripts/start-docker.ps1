$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
& node scripts/init-local-env.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$drawnWindowsPath = (Get-Location).Path
$drawnWslPath = (& wsl -d Ubuntu -- wslpath -a $drawnWindowsPath).Trim()
& wsl -d Ubuntu -u root -- env COMPOSE_BAKE=false DOCKER_BUILDKIT=0 docker compose --project-directory $drawnWslPath --env-file "$drawnWslPath/.env.docker.local" up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'drawn: http://localhost:3000'
