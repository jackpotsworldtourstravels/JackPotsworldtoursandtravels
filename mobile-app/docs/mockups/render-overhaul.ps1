# Renders each screen in ui-overhaul.html to a 2x PNG in ./ui-overhaul/
# Usage (from this folder):  powershell -ExecutionPolicy Bypass -File .\render-overhaul.ps1
# 'Continue': Chrome writes harmless warnings to stderr, which 'Stop' would treat as fatal.
$ErrorActionPreference = 'Continue'
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
$here = $PSScriptRoot
$html = (Join-Path $here 'ui-overhaul.html') -replace '\\', '/'
$out = Join-Path $here 'ui-overhaul'
New-Item -ItemType Directory -Force $out | Out-Null

$tall = @{ '04-home' = 1296 }
$screens = @('01-splash','02-login','03-otp','04-home','05-flight-search','06-airport-picker','07-travellers-sheet',
  '08-flight-results-unavailable','09-flight-results-preview','10-hotel-search','11-destination-picker','12-date-range',
  '13-rooms-guests-sheet','14-hotel-results','15-hotel-detail','16-hotel-rooms','17-packages-landing','18-package-results',
  '19-package-detail','20-checkout','21-confirmation','22-bookings','23-booking-detail','24-explore','25-wishlist',
  '26-profile','27-support-chat','28-loading-skeleton')
$profile = Join-Path $env:TEMP 'jw-mockup-render'
foreach ($s in $screens) {
  $h = if ($tall.ContainsKey($s)) { $tall[$s] } else { 844 }
  $png = Join-Path $out "$s.png"
  & $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 `
    --user-data-dir="$profile" --allow-file-access-from-files --virtual-time-budget=6000 `
    --window-size="390,$h" --screenshot="$png" "file:///$html`?s=$s" 2>$null | Out-Null
  Write-Output ("{0,-32} {1}" -f $s, $(if (Test-Path $png) { 'ok' } else { 'FAILED' }))
}
