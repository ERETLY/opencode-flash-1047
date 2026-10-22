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

# long-session rules: OpenCode v2 loads AGENTS.md on its own, anything else must be listed in the
# top-level "instructions" array (done below). Never overwrite a copy the user may have edited.
RULES_SRC="$ROOT/instructions/long-session.md"
RULES_DST="$CFG_DIR/instructions/long-session.md"
if [ ! -f "$RULES_SRC" ]; then
  echo "missing $RULES_SRC" >&2
  exit 1
fi
mkdir -p "$CFG_DIR/instructions"
if [ -f "$RULES_DST" ] && ! cmp -s "$RULES_SRC" "$RULES_DST"; then
  echo "rules   -> kept your existing $RULES_DST"
else
  cp "$RULES_SRC" "$RULES_DST"
  echo "rules   -> $RULES_DST"
fi

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
  CFG="$CFG" ROOT="$ROOT" CFG_DIR="$CFG_DIR" python3 - <<'PY'
import json, os, re, shutil, datetime

cfg_path = os.environ['CFG']
raw = open(cfg_path, encoding='utf-8-sig').read()

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
            'variants': {
                'low': {'reasoningEffort': 'low'},
                'medium': {'reasoningEffort': 'medium'},
                'high': {'reasoningEffort': 'high'},
                'max': {'reasoningEffort': 'max'},
            },
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
        'keep': 32000,
        'warn': 0.7, 'compact': 0.85, 'hard': 0.93, 'pruneSoft': 0.7,
        'every': 20, 'stallMs': 900000, 'maxResumes': 4, 'resumeCooldownMs': 120000,
    },
})
cfg['plugins'] = plugins

# OpenCode v2 resolves relative `instructions` entries from the workspace upward, so the global
# rules file is referenced with a ~/ (or absolute) path. Do not add it twice.
ins_file = os.path.join(os.environ['CFG_DIR'], 'instructions', 'long-session.md')
rel = os.path.relpath(ins_file, os.path.expanduser('~'))
ref = ('~/' + rel.replace(os.sep, '/')) if not rel.startswith('..') and not os.path.isabs(rel) else ins_file.replace(os.sep, '/')
ins = cfg.get('instructions') if isinstance(cfg.get('instructions'), list) else []
if not any(isinstance(e, str) and e.replace('\\', '/').endswith('long-session.md') for e in ins):
    ins.append(ref)
cfg['instructions'] = ins

# runtime safety net: buffer 40000 -> auto-compaction at 270000, above the plugin's
# 263500 (85%) trigger and below the measured 319123-token ceiling.
# keep.tokens must equal plugins[].options.keep, otherwise compaction is a no-op.
cp = cfg.get('compaction') if isinstance(cfg.get('compaction'), dict) else {}
cp['auto'] = True
keep = cp.get('keep') if isinstance(cp.get('keep'), dict) else {}
keep['tokens'] = 32000
cp['keep'] = keep
cp['buffer'] = 40000
cfg['compaction'] = cp

backup = cfg_path + '.bak.' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
shutil.copyfile(cfg_path, backup)
open(cfg_path, 'w', encoding='utf-8').write(json.dumps(cfg, indent=2) + '\n')
print('config  ->', cfg_path)
print('backup  ->', backup)
PY
elif command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/apply-config.js" --dir "$CFG_DIR"
else
  echo ""
  echo "No python3/node found. The plugin is installed; merge the config block from"
  echo "opencode.snippet.jsonc into $CFG by hand (or ask an AI to follow INSTALL.md)."
  exit 0
fi

echo ""
echo 'done. Restart OpenCode and pick "flash 1047 - Super Free".'
