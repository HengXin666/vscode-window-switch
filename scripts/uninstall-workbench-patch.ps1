$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $args -Wait -PassThru
  exit $process.ExitCode
}

$candidates = @(
  "$env:LOCALAPPDATA\Programs\Microsoft VS Code\resources\app\product.json",
  "$env:ProgramFiles\Microsoft VS Code\resources\app\product.json",
  "$env:ProgramFiles\Microsoft VS Code Insiders\resources\app\product.json"
)
$target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$backup = if ($target) { "$target.window-deck.original" } else { $null }
if (-not $backup -or -not (Test-Path $backup)) { throw "Window Deck product.json backup not found." }
Copy-Item $backup $target -Force
Write-Host "Window Deck terminal API permission removed. Fully quit and reopen VS Code."
