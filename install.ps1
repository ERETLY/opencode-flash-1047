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

# ---------- 1b. long-session rules ----------
# OpenCode v2 loads AGENTS.md on its own; any other file must be listed in the top-level
# "instructions" array (done below). Never overwrite a copy the user may have edited.
$rulesSrc = Join-Path $root 'instructions\long-session.md'
$rulesDst = Join-Path $cfgDir 'instructions\long-session.md'
if (-not (Test-Path $rulesSrc)) { throw "missing $rulesSrc" }
New-Item -ItemType Directory -Force -Path (Split-Path $rulesDst) | Out-Null
if ((Test-Path $rulesDst) -and ((Get-FileHash $rulesSrc).Hash -ne (Get-FileHash $rulesDst).Hash)) {
  Write-Host "rules   -> kept your existing $rulesDst"
} else {
  Copy-Item $rulesSrc $rulesDst -Force
  Write-Host "rules   -> $rulesDst" -ForegroundColor Green
}

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
    keep           = 32000
    warn           = 0.7
    compact        = 0.85
    hard           = 0.93
    pruneSoft      = 0.7
    every          = 20
    stallMs        = 900000
    maxResumes     = 4
    resumeCooldownMs = 120000
  }
}

# runtime safety net: buffer 40000 -> auto-compaction at 270000, above the plugin's
# 263500 (85%) trigger and below the measured 319123-token ceiling.
# keep.tokens must equal plugins[].options.keep, otherwise compaction is a no-op.
$cp = if ($cfg.PSObject.Properties['compaction'] -and $cfg.compaction) { $cfg.compaction } else { [pscustomobject]@{} }
$cp | Add-Member -NotePropertyName auto -NotePropertyValue $true -Force
$keepObj = if ($cp.PSObject.Properties['keep'] -and $cp.keep) { $cp.keep } else { [pscustomobject]@{} }
$keepObj | Add-Member -NotePropertyName tokens -NotePropertyValue 32000 -Force
$cp | Add-Member -NotePropertyName keep -NotePropertyValue $keepObj -Force
$cp | Add-Member -NotePropertyName buffer -NotePropertyValue 40000 -Force
$cfg | Add-Member -NotePropertyName compaction -NotePropertyValue $cp -Force

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

# OpenCode v2 resolves relative `instructions` entries from the workspace upward, so the global
# rules file is referenced with a ~/ (or absolute) path. Do not add it twice.
$homeDir = [System.IO.Path]::GetFullPath($HOME)
$rulesFull = [System.IO.Path]::GetFullPath($rulesDst)
if ($rulesFull.StartsWith($homeDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  $rulesRef = '~/' + (($rulesFull.Substring($homeDir.Length).TrimStart('\', '/')) -replace '\\', '/')
} else {
  $rulesRef = $rulesFull -replace '\\', '/'
}
$ins = @()
if ($cfg.PSObject.Properties['instructions'] -and $cfg.instructions) { $ins = @($cfg.instructions) }
$hasRules = $false
foreach ($e in $ins) { if ($e -is [string] -and (($e -replace '\\', '/') -like '*long-session.md')) { $hasRules = $true } }
if (-not $hasRules) { $ins += $rulesRef }
$cfg | Add-Member -NotePropertyName instructions -NotePropertyValue $ins -Force

$backup = "$cfgFile.bak." + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $cfgFile $backup
$cfg | ConvertTo-Json -Depth 30 | ForEach-Object { [System.IO.File]::WriteAllText($cfgFile, $_, $utf8) }
Write-Host "config  -> $cfgFile" -ForegroundColor Green
Write-Host "backup  -> $backup"

Write-Host ''
Write-Host 'done. Quit OpenCode completely, start it again, then pick "flash 1047 - Super Free".' -ForegroundColor Cyan
