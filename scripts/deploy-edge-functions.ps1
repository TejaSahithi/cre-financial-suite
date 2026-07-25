# Deploy all Supabase edge functions to the linked project.
# Run from the repo root in PowerShell:
#   .\scripts\deploy-edge-functions.ps1
#
# Migrations are NOT pushed here (db push requires an interactive password).
# To push migrations:  npx supabase db push
# (You'll be prompted for your database password.)
#
# The function list is auto-discovered from supabase\functions\* (any folder
# with its own index.ts), not hardcoded. A previous hardcoded list of 34 names
# silently drifted ~60 functions behind the actual folder count over time —
# including lease-extraction-worker, whose already-merged compute-exhaustion
# fix (commits 0299555/52abf23) never got deployed because this script never
# tried to deploy that function at all. Auto-discovery makes that whole class
# of drift impossible: every folder with an index.ts is deployed, every run.
# `_`-prefixed folders (e.g. _shared, _tests) and helper folders with no
# index.ts (e.g. azure/, a shared .ts module with no function entrypoint) are
# excluded automatically.
$ErrorActionPreference = "Continue"
$ProjectRef = "cjwdwuqqdokblakheyjb"

$Functions = Get-ChildItem -Path "supabase\functions" -Directory |
    Where-Object { $_.Name -notlike "_*" -and (Test-Path (Join-Path $_.FullName "index.ts")) } |
    Select-Object -ExpandProperty Name |
    Sort-Object

Write-Host ""
Write-Host ("=== Deploying " + $Functions.Count + " edge functions to " + $ProjectRef + " ===") -ForegroundColor Yellow

$Failures = @()
foreach ($fn in $Functions) {
    $fnPath = "supabase\functions\" + $fn
    if (-not (Test-Path $fnPath)) {
        Write-Host ("[skip] " + $fn + " - folder not found") -ForegroundColor DarkYellow
        continue
    }
    Write-Host (">>> " + $fn) -ForegroundColor Cyan
    # Merge stderr into stdout so CLI status messages don't get treated as errors.
    & npx --yes supabase functions deploy $fn --project-ref $ProjectRef --use-api 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) {
        Write-Host ("[ok]   " + $fn) -ForegroundColor Green
    } else {
        Write-Host ("[FAIL] " + $fn + " (exit " + $LASTEXITCODE + ")") -ForegroundColor Red
        $Failures += $fn
    }
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Yellow
$DeployedCount = $Functions.Count - $Failures.Count
Write-Host ("Deployed: " + $DeployedCount + " / " + $Functions.Count)
if ($Failures.Count -gt 0) {
    Write-Host ("Failed:   " + $Failures.Count + " - " + ($Failures -join ', ')) -ForegroundColor Red
    Write-Host ""
    Write-Host "To retry a failed function:  npx supabase functions deploy <name> --project-ref $ProjectRef --use-api"
    exit 1
}
Write-Host "All functions deployed cleanly." -ForegroundColor Green
Write-Host ""
Write-Host "Migrations: run separately with:" -ForegroundColor Yellow
Write-Host "  npx supabase db push" -ForegroundColor Cyan
Write-Host "(You'll be prompted for your database password.)"
