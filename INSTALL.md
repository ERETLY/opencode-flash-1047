# INSTALL — procedure for an AI assistant

You are installing a model entry + plugin into **OpenCode 2.x** on the user's machine.
Follow the steps exactly. Do not invent files that are not listed here.
Everything you need is inside this repository.

## 0. Locate the OpenCode config directory

- Windows: `C:\Users\<user>\.config\opencode` (i.e. `%USERPROFILE%\.config\opencode`)
- macOS / Linux: `~/.config/opencode`

The config file is `opencode.jsonc` or `opencode.json` in that directory.
If neither exists, create `opencode.json`.

## 1. Copy the plugin

Copy:

```
plugin/resilience/index.ts
```

to:

```
<config-dir>/plugins/resilience/index.ts
```

Create the `plugins/resilience` directory if needed. The plugin MUST be a directory that
contains `index.ts` — a flat `resilience.ts` file is not loaded by OpenCode 2.x.

## 1b. Copy the long-session rules

Copy:

```
instructions/long-session.md
```

to:

```
<config-dir>/instructions/long-session.md
```

Do not overwrite the destination if it already exists and differs: the user may have edited it.

## 2. Merge this into the config file

Add the `flash1047` key inside the top-level `provider` object, the plugin entry inside the
top-level `plugins` array, the rules file inside the top-level `instructions` array, and tune
the top-level `compaction` object. Keep everything else that is already in the file.

```jsonc
{
  "provider": {
    "flash1047": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "flash 1047",
      "options": {
        "baseURL": "https://opencode.ai/inference/openai/v1",
        "apiKey": "public"
      },
      "models": {
        "deepseek-v4.1-flash-free": {
          "name": "flash 1047 - Super Free",
          "limit": { "context": 310000, "output": 32000 },
          "capabilities": {
            "tools": true,
            "reasoning": true,
            "input": ["text", "image"],
            "output": ["text"],
            "temperature": true
          },
          "cost": { "input": 0, "output": 0 },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        }
      }
    }
  },
  "compaction": {
    "auto": true,
    "keep": { "tokens": 32000 },
    "buffer": 40000
  },
  "instructions": ["~/.config/opencode/instructions/long-session.md"],
  "plugins": [
    {
      "package": "./plugins/resilience",
      "options": {
        "onlyProviderID": "flash1047",
        "onlyModelID": "deepseek-v4.1-flash-free",
        "contextLimit": 310000,
        "keep": 32000,
        "warn": 0.7,
        "compact": 0.85,
        "pruneSoft": 0.7,
        "hard": 0.93,
        "every": 20,
        "stallMs": 900000,
        "maxResumes": 4,
        "resumeCooldownMs": 120000
      }
    }
  ]
}
```

Rules:

- The model **key** must stay `deepseek-v4.1-flash-free` — that string is sent upstream as the
  model name. Only `name` is cosmetic.
- Do not remove or modify the existing `opencode` provider. The point is to have both models.
- The `instructions` entry must be a `~/` or absolute path (relative entries are searched from
  the workspace upward, not from the config directory). If `instructions` already contains an
  entry ending in `long-session.md`, do not add a second one. Keep the user's other entries.
- If `plugins` already contains an entry whose `package` is `./plugins/resilience`, replace
  that entry instead of adding a duplicate.
- Back up the config first (`opencode.jsonc.bak`) — editing JSONC by machine can drop comments.
- **`contextLimit` must equal `limit.context`** (310 000). **`options.keep` must equal
  `compaction.keep.tokens`** (32 000). Both mismatches cause constant compaction:
  the plugin asks below the runtime's keep window and gets `Nothing to compact yet`.
- **`compaction.buffer` must be 40 000.** Without it OpenCode auto-compacts at
  `310000 - max(15%, 16000) = 263500`, exactly at the plugin's trigger. With the buffer the
  runtime fires at 270 000, above the plugin and below the measured 319K ceiling.
- Do not lower `buffer` below 40 000 and do not raise `compact` above 0.85 without re-measuring.

Prefer the automated merge if Node.js is available:

```bash
node scripts/apply-config.js
```

It finds the config, backs it up, merges all four blocks (provider, compaction, plugins,
instructions) idempotently and copies the plugin and the rules file.

## 3. Restart OpenCode

Quit it completely (Windows: tray icon -> Quit; do not just close the window) and start it
again. The plugin, providers and compaction settings load at startup.

## 4. Verify

1. The model picker shows **flash 1047 - Super Free** with provider `flash1047`, next to the
   original **DeepSeek V4.1 Flash Free**.
2. Send any short prompt to the new model; it answers normally.
3. In the project directory, `.omo/logs/resilience.jsonl` contains a line with `"at":"setup"`,
   `"limit":310000`, `"compact":0.85`, `"keep":32000` and `"keepFloor":35000`.
4. Send a prompt to the **original** model and confirm no new lines appear in that log file for
   that session — the plugin is scoped to the new provider only.
5. If the user has an existing long session, confirm compaction happens at ~85%, not every
   turn. The log shows `compact-request` with `used` close to 263 500; a `compact-error`
   containing `Nothing to compact yet` means `keep` and `compaction.keep.tokens` disagree.

If step 4 fails, the plugin is loaded but the scope options are missing: re-check
`plugins[].options.onlyProviderID` and `onlyModelID`.

## 5. Optional: sanity-check the context window

OpenCode passes `limit.context` to the client-side budget. 310 000 was measured safe against
the free gateway (319 123 accepted, 325 760 rejected). If the user reports
`400 context_length_exceeded`, lower `limit.context`, `options.contextLimit` and
`compaction.buffer` together — keep `limit.context - buffer` above the plugin trigger
(`compact * limit.context`) and below 319 000.
