# Deploy all Supabase edge functions to the linked project.
# Run from the repo root in PowerShell:
#   .\scripts\deploy-edge-functions.ps1
#
# Migrations are NOT pushed here (db push requires an interactive password).
# To push migrations:  npx supabase db push
# (You'll be prompted for your database password.)

# Use Continue (not Stop) — the Supabase CLI writes upload status to stderr,
# and Stop would abort on the first status line. We track success via
# $LASTEXITCODE per command instead.
$ErrorActionPreference = "Continue"
$ProjectRef = "cjwdwuqqdokblakheyjb"

$Functions = @(
    "parse-document-azure",
    "parse-file",
    "extract-document-fields",
    "extract-with-custom-fields",
    "extract-lease",
    "extract-lease-expense-rules",
    "normalize-pdf-output",
    "validate-data",
    "store-data",
    "ingest-file",
    "upload-handler",
    "pipeline-status",
    "review-approve",
    "compute-lease",
    "compute-revenue",
    "compute-expense",
    "compute-cam",
    "compute-budget",
    "compute-reconciliation",
    "generate-budget",
    "signup",
    "first-login",
    "accept-invite",
    "invite-user",
    "invite-client",
    "complete-onboarding",
    "approve-organization",
    "approve-request",
    "reset-mfa",
    "save-security-questions",
    "debug-user",
    "send-email",
    "submit-contact",
    "export-data",
    "custom-fields",
    "validate-address-ups"
)

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
