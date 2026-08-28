# tools/deploy-pages.ps1 — build the release and push it to GitHub Pages.
#
# Publishes the built release/ folder to the gh-pages branch (site-only: no dev
# files), pushes it, and returns the working tree to main.
#
# Usage:
#   powershell -File tools\deploy-pages.ps1 [-Repo <url>] [-SkipBuild]
#
# Args:
#   -Repo       remote URL. If omitted, uses the existing 'origin' remote.
#   -SkipBuild  skip `node tools/make-release.js` (re-push an existing release/).
#
# Prereqs: git, node, an existing GitHub repo (public for free Pages), and
# GitHub Pages enabled with Source = "Deploy from a branch" -> gh-pages / root.
# Site URL: https://<user>.github.io/<repo>/
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

# Publish from a clean main (the dev source branch).
git checkout main
if ($LASTEXITCODE -ne 0) { throw "could not switch to main" }

# Replace the local gh-pages branch wholesale (history-less site deploys).
git branch -D gh-pages 2>$null | Out-Host
git checkout --orphan gh-pages
if ($LASTEXITCODE -ne 0) { throw "could not create gh-pages branch" }

# Clear every tracked file from the orphan branch (index + working tree).
git rm -rf . 2>$null | Out-Host

# Stage ONLY the release contents at the branch root.
Get-ChildItem -Path (Join-Path $Root "release") -Force | ForEach-Object {
    Copy-Item -Recurse -Force $_.FullName (Join-Path $Root $_.Name)
}
# .nojekyll: serve files as-is (no Jekyll build).
Set-Content -Path (Join-Path $Root ".nojekyll") -Value "" -NoNewline
# Reuse main's full .gitignore (not a trimmed one) so a git add -A here can
# never pull in node_modules, tmp artifacts, secrets, or build outputs.
git show main:.gitignore | Set-Content (Join-Path $Root ".gitignore")

git add -A | Out-Host
git commit -m "release site" 2>$null | Out-Host

# Restore the dev working tree before pushing.
git checkout main
if ($LASTEXITCODE -ne 0) { throw "could not return to main" }

if (-not $Repo) {
    $Repo = git config --get remote.origin.url 2>$null
    if (-not $Repo) { $Repo = Read-Host "GitHub repo URL (e.g. https://github.com/<user>/mapper.git)" }
}
git remote remove origin 2>$null | Out-Host
git remote add origin $Repo

git push --force -u origin gh-pages
Write-Host "== Pushed gh-pages to $Repo =="
Write-Host "Enable Pages: repo Settings -> Pages -> Deploy from a branch -> gh-pages / root"
Write-Host "Site URL: https://<user>.github.io/<repo>/"
