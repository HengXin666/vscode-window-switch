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
if (-not $target) { throw "VS Code product.json not found." }

$backup = "$target.window-deck.original"
if (-not (Test-Path $backup)) { Copy-Item $target $backup }
$product = Get-Content -Raw $target | ConvertFrom-Json
if (-not $product.extensionEnabledApiProposals) {
  $product | Add-Member -MemberType NoteProperty -Name extensionEnabledApiProposals -Value ([pscustomobject]@{})
}
$property = $product.extensionEnabledApiProposals.PSObject.Properties["HengXin666.window-deck"]
$current = if ($property) { @($property.Value) } else { @() }
$values = @($current + "terminalDataWriteEvent" | Select-Object -Unique)
if ($property) { $property.Value = $values } else {
  $product.extensionEnabledApiProposals | Add-Member -MemberType NoteProperty -Name "HengXin666.window-deck" -Value $values
}
$product | ConvertTo-Json -Depth 100 | Set-Content -Encoding UTF8 $target
Write-Host "Window Deck terminal API permission installed. Fully quit and reopen VS Code normally."
