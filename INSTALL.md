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

## 2. Merge this into the config file

Add the `flash1047` key inside the top-level `provider` object and the plugin entry inside the
top-level `plugins` array. Keep everything that is already in the file.

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
  "plugins": [
    {
      "package": "./plugins/resilience",
      "options": {
        "onlyProviderID": "flash1047",
        "onlyModelID": "deepseek-v4.1-flash-free",
        "contextLimit": 310000,
        "warn": 0.7,
        "compact": 0.85,
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
- If `plugins` already contains an entry whose `package` is `./plugins/resilience`, replace
  that entry instead of adding a duplicate.
- Back up the config first (`opencode.jsonc.bak`) — editing JSONC by machine can drop comments.

Prefer the automated merge if Node.js is available:

```bash
node scripts/apply-config.js
```

It finds the config, backs it up, merges both blocks idempotently and copies the plugin.

## 3. Restart OpenCode

Quit it completely (Windows: tray icon -> Quit; do not just close the window) and start it
again. The plugin and providers load at startup.

## 4. Verify

1. The model picker shows **flash 1047 - Super Free** with provider `flash1047`, next to the
   original **DeepSeek V4.1 Flash Free**.
2. Send any short prompt to the new model; it answers normally.
3. In the project directory, `.omo/logs/resilience.jsonl` contains a line with `"at":"setup"`
   and `"onlyProviderID":"flash1047"`.
4. Send a prompt to the **original** model and confirm no new lines appear in that log file
   for that session — the plugin is scoped to the new provider only.

If step 4 fails, the plugin is loaded but the scope options are missing: re-check
`plugins[].options.onlyProviderID`.

## 5. Optional: sanity-check the context window

OpenCode passes `limit.context` to the client-side budget. 310 000 was measured safe against
the free gateway (319 123 accepted, 325 760 rejected). If the user reports
`400 context_length_exceeded`, lower both `limit.context` and `contextLimit` to `250000`.
