# tools/deploy-pages.ps1 — build the release and push it to GitHub Pages.
#
# Automates the manual steps from "PLAN re Release.md":
#   2. Build the release:   node tools/make-release.js
#   3. Put release/ on a gh-pages orphan branch and push.
#
# Usage:
#   powershell -File tools\deploy-pages.ps1 -Repo https://github.com/<user>/mapper.git
#
# Args:
#   -Repo   remote URL. If omitted, uses the existing 'origin' remote, or prompts.
#   -SkipBuild  skip `node tools/make-release.js` (re-push an existing release/).
#
# Prereqs: git, node, and (for creation) a GitHub account. The GitHub repo must
# already exist (public, for free Pages). First deploy takes ~1 minute; the site
# is then at https://<user>.github.io/<repo>/.
param(
    [string]$Repo = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

if (-not $SkipBuild) {
    Write-Host "== Building release =="
    node tools\make-release.js
    if ($LASTEXITCODE -ne 0) { throw "make-release.js failed" }
} else {
    Write-Host "== Skipping build (reusing release/) =="
}

# Determine the remote URL.
if (-not $Repo) {
    $existing = git config --get remote.origin.url 2>$null
    if ($existing) { $Repo = $existing } 
    else { $Repo = Read-Host "GitHub repo URL (e.g. https://github.com/<user>/mapper.git)" }
}

# Init git if needed.
if (-not (Test-Path (Join-Path $Root ".git"))) {
    git init | Out-Host
}

# Create an orphan branch whose root is release/ (the site), keeping dev files
# out of the published branch.
git checkout --orphan gh-pages 2>$null | Out-Host
if ($LASTEXITCODE -ne 0) { throw "could not create gh-pages branch" }
# Remove everything currently tracked (from prior publishes) so we can replace
# the tree with a clean copy of release/.
git rm -rf --cached . 2>$null | Out-Host
git rm -rf . 2>$null | Out-Host
# Stage only release/ at the branch root.
Get-ChildItem -Path (Join-Path $Root "release") -Force | ForEach-Object {
    Copy-Item -Recurse -Force $_.FullName (Join-Path $Root $_.Name)
}
# .nojekyll so GitHub Pages serves files as-is (no Jekyll build).
Set-Content -Path (Join-Path $Root ".nojekyll") -Value "" -NoNewline

git add -A | Out-Host
git commit -m "release" 2>$null | Out-Host

git remote remove origin 2>$null | Out-Host
git remote add origin $Repo
git push --force -u origin gh-pages
Write-Host "== Pushed to $Repo / gh-pages =="
Write-Host "Enable Pages: Settings -> Pages -> Deploy from a branch -> gh-pages / root"
Write-Host "Site URL (after enabling Pages): https://<user>.github.io/<repo>/"
