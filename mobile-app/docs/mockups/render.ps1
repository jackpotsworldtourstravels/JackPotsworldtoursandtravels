# Renders each mockup screen in redesign.html to a 2x PNG in ./redesign/
# Usage (from this folder):  powershell -ExecutionPolicy Bypass -File .\render.ps1
# 'Continue': Chrome writes harmless warnings to stderr, which 'Stop' would treat as fatal.
$ErrorActionPreference = 'Continue'
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
$here = $PSScriptRoot
$html = (Join-Path $here 'redesign.html') -replace '\\', '/'
$out = Join-Path $here 'redesign'
New-Item -ItemType Directory -Force $out | Out-Null

$screens = [ordered]@{
  '01-splash' = 844; '02-home-flights' = 1990; '03-home-hotels' = 844; '04-home-packages' = 844
  '05-travellers-sheet' = 844; '06-flight-results-preview' = 844; '07-flights-unavailable' = 844
  '08-hotel-results' = 844; '09-hotel-filters' = 844; '10-hotel-detail' = 844; '11-room-selection' = 844
  '12-review-and-pay' = 844; '13-package-list' = 844; '14-package-detail' = 844; '15-my-bookings' = 844
  '16-booking-status' = 844; '17-profile' = 844; '18-support-chat' = 844
}
$profile = Join-Path $env:TEMP 'jw-mockup-render'
foreach ($s in $screens.Keys) {
  $png = Join-Path $out "$s.png"
  & $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 `
    --user-data-dir="$profile" --allow-file-access-from-files --virtual-time-budget=6000 `
    --window-size="390,$($screens[$s])" --screenshot="$png" "file:///$html`?s=$s" 2>$null | Out-Null
  Write-Output ("{0,-28} {1}" -f $s, $(if (Test-Path $png) { 'ok' } else { 'FAILED' }))
}
