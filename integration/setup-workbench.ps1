$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$upstream = Join-Path $root 'external/pi-web-ui'
if (-not (Test-Path $upstream)) {
  git clone https://github.com/xing-shuyin/pi-web-ui.git $upstream
  if ($LASTEXITCODE) { throw 'Workbench clone failed' }
  git -C $upstream checkout 5316518b43ea9571b3237610bef79efb7ce1e1b1
  if ($LASTEXITCODE) { throw 'Pinned checkout failed' }
}
if (-not (Test-Path (Join-Path $upstream 'package-lock.json'))) { throw 'Missing workbench source' }
$patch = Join-Path $root 'patches/pi-web-ui-agent-service.patch'
git -C $upstream apply --reverse --check $patch 2>$null
if ($LASTEXITCODE -ne 0) {
  git -C $upstream apply --check $patch
  if ($LASTEXITCODE) { throw 'Workbench patch conflicts; existing files were preserved' }
  git -C $upstream apply $patch
  if ($LASTEXITCODE) { throw 'Workbench patch failed' }
}
Push-Location $upstream
try {
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'Dependency install failed' }
  npm run build
  if ($LASTEXITCODE) { throw 'Workbench build failed' }
  npm run build:web -- --base=/workbench/
  if ($LASTEXITCODE) { throw 'Workbench subpath build failed' }
} finally { Pop-Location }
Write-Host 'Ready: node integration/workbench-manager.cjs'

