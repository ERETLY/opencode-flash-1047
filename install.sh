#!/usr/bin/env sh
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

echo "flash 1047 installer"
echo "config dir: $CFG_DIR"

mkdir -p "$CFG_DIR/plugins/resilience"
if [ ! -f "$ROOT/plugin/resilience/index.ts" ]; then
  echo "missing $ROOT/plugin/resilience/index.ts" >&2
  exit 1
fi
cp "$ROOT/plugin/resilience/index.ts" "$CFG_DIR/plugins/resilience/index.ts"
echo "plugin  -> $CFG_DIR/plugins/resilience/index.ts"

CFG=""
if [ -n "${OPENCODE_CONFIG:-}" ] && [ -f "$OPENCODE_CONFIG" ]; then
  CFG="$OPENCODE_CONFIG"
elif [ -f "$CFG_DIR/opencode.jsonc" ]; then
  CFG="$CFG_DIR/opencode.jsonc"
elif [ -f "$CFG_DIR/opencode.json" ]; then
  CFG="$CFG_DIR/opencode.json"
fi

if [ -z "$CFG" ]; then
  CFG="$CFG_DIR/opencode.json"
  printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$CFG"
  echo "config  -> $CFG (new)"
fi

if command -v python3 >/dev/null 2>&1; then
  CFG="$CFG" ROOT="$ROOT" python3 - <<'PY'
import json, os, re, shutil, datetime

cfg_path = os.environ['CFG']
raw = open(cfg_path, encoding='utf-8').read()

def strip(s):
    out, i, n = [], 0, len(s)
    instr = esc = inline = block = False
    while i < n:
        c = s[i]; nxt = s[i+1] if i + 1 < n else ''
        if inline:
            if c == '\n': inline = False; out.append(c)
        elif block:
            if c == '*' and nxt == '/': block = False; i += 1
        elif instr:
            out.append(c)
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': instr = False
        elif c == '"': instr = True; out.append(c)
        elif c == '/' and nxt == '/': inline = True; i += 1
        elif c == '/' and nxt == '*': block = True; i += 1
        else: out.append(c)
        i += 1
    return re.sub(r',\s*([}\]])', r'\1', ''.join(out))

try:
    cfg = json.loads(raw)
except json.JSONDecodeError:
    cfg = json.loads(strip(raw))

cfg.setdefault('provider', {})['flash1047'] = {
    'npm': '@ai-sdk/openai-compatible',
    'name': 'flash 1047',
    'options': {'baseURL': 'https://opencode.ai/inference/openai/v1', 'apiKey': 'public'},
    'models': {
        'deepseek-v4.1-flash-free': {
            'name': 'flash 1047 - Super Free',
            'limit': {'context': 310000, 'output': 32000},
            'capabilities': {
                'tools': True, 'reasoning': True,
                'input': ['text', 'image'], 'output': ['text'], 'temperature': True,
            },
            'cost': {'input': 0, 'output': 0},
        }
    },
}

plugins = cfg.get('plugins') or []
plugins = [p for p in plugins
           if 'plugins/resilience' not in str(p.get('package') if isinstance(p, dict) else p).replace('\\', '/')]
plugins.append({
    'package': './plugins/resilience',
    'options': {
        'onlyProviderID': 'flash1047',
        'onlyModelID': 'deepseek-v4.1-flash-free',
        'contextLimit': 310000,
        'warn': 0.7, 'compact': 0.85, 'hard': 0.93,
        'every': 20, 'stallMs': 900000, 'maxResumes': 4,
    },
})
cfg['plugins'] = plugins

backup = cfg_path + '.bak.' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
shutil.copyfile(cfg_path, backup)
open(cfg_path, 'w', encoding='utf-8').write(json.dumps(cfg, indent=2) + '\n')
print('config  ->', cfg_path)
print('backup  ->', backup)
PY
elif command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/apply-config.js"
else
  echo ""
  echo "No python3/node found. The plugin is installed; merge the config block from"
  echo "opencode.snippet.jsonc into $CFG by hand (or ask an AI to follow INSTALL.md)."
  exit 0
fi

echo ""
echo 'done. Restart OpenCode and pick "flash 1047 - Super Free".'
