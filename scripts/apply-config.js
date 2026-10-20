#!/usr/bin/env node
// Idempotent installer for the "flash 1047" model + resilience plugin.
// Usage: node scripts/apply-config.js [--dry-run]
const fs = require('fs')
const path = require('path')
const os = require('os')

const DRY = process.argv.includes('--dry-run')
const dirArg = (() => {
  const i = process.argv.indexOf('--dir')
  return i > -1 ? process.argv[i + 1] : ''
})()
const root = path.resolve(__dirname, '..')
const cfgDir = dirArg ? path.resolve(dirArg) : path.join(os.homedir(), '.config', 'opencode')

const PROVIDER = {
  npm: '@ai-sdk/openai-compatible',
  name: 'flash 1047',
  options: {
    baseURL: 'https://opencode.ai/inference/openai/v1',
    apiKey: 'public',
  },
  models: {
    'deepseek-v4.1-flash-free': {
      name: 'flash 1047 - Super Free',
      limit: { context: 310000, output: 32000 },
      capabilities: {
        tools: true,
        reasoning: true,
        input: ['text', 'image'],
        output: ['text'],
        temperature: true,
      },
      cost: { input: 0, output: 0 },
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
        max: { reasoningEffort: 'max' },
      },
    },
  },
}

const PLUGIN = {
  package: './plugins/resilience',
  options: {
    onlyProviderID: 'flash1047',
    onlyModelID: 'deepseek-v4.1-flash-free',
    contextLimit: 310000,
    warn: 0.7,
    compact: 0.85,
    hard: 0.93,
    every: 20,
    stallMs: 900000,
    maxResumes: 4,
    resumeCooldownMs: 120000,
  },
}

// strip // and /* */ comments plus trailing commas, outside of strings
function stripJsonc(src) {
  let out = ''
  let inStr = false
  let esc = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function findConfig() {
  const fromEnv = process.env.OPENCODE_CONFIG
  const candidates = [fromEnv, path.join(cfgDir, 'opencode.jsonc'), path.join(cfgDir, 'opencode.json')].filter(Boolean)
  return candidates.find((f) => fs.existsSync(f)) || null
}

function copyPlugin() {
  const from = path.join(root, 'plugin', 'resilience', 'index.ts')
  const to = path.join(cfgDir, 'plugins', 'resilience', 'index.ts')
  if (!fs.existsSync(from)) throw new Error('missing ' + from)
  if (DRY) return console.log('[dry] copy\n  ' + from + '\n  -> ' + to)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  console.log('plugin  ->', to)
}

function mergeConfig(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch {
    cfg = JSON.parse(stripJsonc(raw))
  }

  cfg.provider = cfg.provider || {}
  cfg.provider.flash1047 = PROVIDER

  const list = Array.isArray(cfg.plugins) ? cfg.plugins : []
  const keep = list.filter((p) => {
    const name = typeof p === 'string' ? p : p && p.package
    return !(typeof name === 'string' && name.replace(/\\\\/g, '/').includes('plugins/resilience'))
  })
  keep.push(PLUGIN)
  cfg.plugins = keep

  const text = JSON.stringify(cfg, null, 2) + '\n'
  if (DRY) {
    console.log('[dry] config merge ->', file)
    console.log(text)
    return
  }
  const backup = file + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.writeFileSync(backup, raw)
  fs.writeFileSync(file, text)
  console.log('config  ->', file)
  console.log('backup  ->', backup)
}

function createConfig() {
  const file = path.join(cfgDir, 'opencode.json')
  const cfg = { $schema: 'https://opencode.ai/config.json', provider: { flash1047: PROVIDER }, plugins: [PLUGIN] }
  if (DRY) return console.log('[dry] create', file)
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  console.log('config  ->', file, '(new)')
}

try {
  fs.mkdirSync(cfgDir, { recursive: true })
  copyPlugin()
  const file = findConfig()
  if (file) mergeConfig(file)
  else createConfig()
  console.log('\ndone. restart OpenCode and pick "flash 1047 - Super Free" (provider flash1047).')
} catch (e) {
  console.error('install failed:', e.message)
  process.exit(1)
}
