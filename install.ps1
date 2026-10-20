param(
  [string]$ConfigDir = ''
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cfgDir = if ($ConfigDir) { $ConfigDir } else { Join-Path $HOME '.config\opencode' }

Write-Host 'flash 1047 installer' -ForegroundColor Cyan
Write-Host "config dir: $cfgDir"

# ---------- 1. plugin ----------
$pluginSrc = Join-Path $root 'plugin\resilience\index.ts'
$pluginDst = Join-Path $cfgDir 'plugins\resilience\index.ts'
if (-not (Test-Path $pluginSrc)) { throw "missing $pluginSrc" }
New-Item -ItemType Directory -Force -Path (Split-Path $pluginDst) | Out-Null
Copy-Item $pluginSrc $pluginDst -Force
Write-Host "plugin  -> $pluginDst" -ForegroundColor Green

# ---------- 2. config ----------
$cfgFile = $null
if ($env:OPENCODE_CONFIG -and (Test-Path $env:OPENCODE_CONFIG)) { $cfgFile = $env:OPENCODE_CONFIG }
elseif (Test-Path (Join-Path $cfgDir 'opencode.jsonc')) { $cfgFile = Join-Path $cfgDir 'opencode.jsonc' }
elseif (Test-Path (Join-Path $cfgDir 'opencode.json')) { $cfgFile = Join-Path $cfgDir 'opencode.json' }

function ConvertFrom-Jsonc([string]$text) {
  $t = [regex]::Replace($text, '/\*[\s\S]*?\*/', '')
  $t = [regex]::Replace($t, '(?m)^\s*//.*$', '')
  $t = [regex]::Replace($t, ',\s*([}\]])', '$1')
  return $t | ConvertFrom-Json
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not $cfgFile) {
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  $cfgFile = Join-Path $cfgDir 'opencode.json'
  $seed = @{ '$schema' = 'https://opencode.ai/config.json' } | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($cfgFile, $seed, $utf8)
  Write-Host "config  -> $cfgFile (new)" -ForegroundColor Green
}

$raw = Get-Content $cfgFile -Raw
$cfg = ConvertFrom-Jsonc $raw

$provider = [ordered]@{
  npm     = '@ai-sdk/openai-compatible'
  name    = 'flash 1047'
  options = [ordered]@{
    baseURL = 'https://opencode.ai/inference/openai/v1'
    apiKey  = 'public'
  }
  models  = [ordered]@{
    'deepseek-v4.1-flash-free' = [ordered]@{
      name         = 'flash 1047 - Super Free'
      limit        = [ordered]@{ context = 310000; output = 32000 }
      capabilities = [ordered]@{
        tools       = $true
        reasoning   = $true
        input       = @('text', 'image')
        output      = @('text')
        temperature = $true
      }
      cost         = [ordered]@{ input = 0; output = 0 }
      variants     = [ordered]@{
        low    = [ordered]@{ reasoningEffort = 'low' }
        medium = [ordered]@{ reasoningEffort = 'medium' }
        high   = [ordered]@{ reasoningEffort = 'high' }
        max    = [ordered]@{ reasoningEffort = 'max' }
      }
    }
  }
}

$pluginEntry = [ordered]@{
  package = './plugins/resilience'
  options = [ordered]@{
    onlyProviderID = 'flash1047'
    onlyModelID    = 'deepseek-v4.1-flash-free'
    contextLimit   = 310000
    warn           = 0.7
    compact        = 0.85
    hard           = 0.93
    every          = 20
    stallMs        = 900000
    maxResumes     = 4
    resumeCooldownMs = 120000
  }
}

if (-not $cfg.PSObject.Properties['provider']) { $cfg | Add-Member -NotePropertyName provider -NotePropertyValue ([pscustomobject]@{}) }
$cfg.provider | Add-Member -NotePropertyName flash1047 -NotePropertyValue ([pscustomobject]$provider) -Force

$kept = @()
if ($cfg.PSObject.Properties['plugins'] -and $cfg.plugins) {
  foreach ($p in $cfg.plugins) {
    $name = if ($p -is [string]) { $p } else { $p.package }
    if ($name -and $name -replace '\\', '/' -match 'plugins/resilience') { continue }
    $kept += $p
  }
}
$kept += [pscustomobject]$pluginEntry
$cfg | Add-Member -NotePropertyName plugins -NotePropertyValue $kept -Force

$backup = "$cfgFile.bak." + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $cfgFile $backup
$cfg | ConvertTo-Json -Depth 30 | ForEach-Object { [System.IO.File]::WriteAllText($cfgFile, $_, $utf8) }
Write-Host "config  -> $cfgFile" -ForegroundColor Green
Write-Host "backup  -> $backup"

Write-Host ''
Write-Host 'done. Quit OpenCode completely, start it again, then pick "flash 1047 - Super Free".' -ForegroundColor Cyan
