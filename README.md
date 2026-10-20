# flash 1047 - Super Free

An extra, long-session-hardened model entry for **OpenCode 2.x**.

It adds a second copy of the free `deepseek-v4.1-flash-free` model under its own provider
(`flash1047`), with a **310K context window** and a resilience plugin that keeps multi-hour
sessions alive: adaptive tool-output pruning, proactive compaction, crash/retry auto-resume,
stall detection and a disk-backed long-session protocol.

Your original `opencode/deepseek-v4.1-flash-free` entry stays untouched and keeps working
exactly as before. The plugin is scoped to the new provider only.

## What you get

| | original | flash 1047 |
|---|---|---|
| provider | `opencode` | `flash1047` |
| model id | `deepseek-v4.1-flash-free` | `deepseek-v4.1-flash-free` |
| context | 200 000 (metadata) | **310 000** (measured safe) |
| output | 32 000 | 32 000 |
| cost | $0 | **$0** |
| resilience plugin | no | **yes** |

Measured on the live free endpoint: 319 123 tokens accepted, 325 760 rejected with
`400 context_length_exceeded`. 310 000 leaves headroom for tool schemas and the reply.

## Install (human)

1. Download this repo (Code -> Download ZIP) and unpack it.
2. Run the installer:

   Windows (PowerShell):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   macOS / Linux:
   ```bash
   bash install.sh
   ```

3. Restart OpenCode.
4. Pick the model **flash 1047 - Super Free** (provider `flash1047`).

No Node.js is needed for the manual path; the installers only use it when it happens to be
available and fall back to printing the exact steps otherwise.

Custom config location:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ConfigDir "D:\tools\opencode"
```

```bash
node scripts/apply-config.js --dir "D:\tools\opencode"   # cross-platform merge
```

`install.sh` honours `XDG_CONFIG_HOME` as well as `$HOME`.

## Install (AI assistant)

Point your assistant at `INSTALL.md` and say: *"install this model"*. That file is written
as a step-by-step procedure for an agent with file access.

## What the plugin does

- **Tool-output pruning** – past a soft threshold, the middle of stale tool results is elided
  and replaced with a marker telling the model to re-read with `grep`/`offset`/`limit`.
- **Proactive compaction** – at 85% of the 310K window it asks OpenCode to compact, with a
  3-minute cooldown so it cannot thrash.
- **Compaction note** – injects tool count, last tool, last user prompt and `.omo/state.md`
  into the compaction request so the summary keeps operational state.
- **Checkpoints** – writes `.omo/checkpoints/<session>.json` every 20 tool calls, on
  execution start/finish, and around compactions.
- **Retry policy** – 429/408/409/425/5xx/transport errors retried with 5s -> 120s backoff.
- **Auto-resume** – after retries are exhausted (and the error is not auth/model-fatal) the
  session is resumed with a "continue where you left off" prompt, max 4 times.
- **Stall detection** – no provider event for 15 minutes with no pending tools -> interrupt
  and resume.
- **Long-session protocol** – one system block per session: keep `.omo/state.md`, grep large
  files instead of reading them whole, process bulk data with scripts, survive compaction.

The plugin never touches your other models: it exits immediately unless
`providerID === "flash1047"`.

## Verified on 2.0.32

| test | result |
|---|---|
| model list | `flash1047/deepseek-v4.1-flash-free` + `opencode/deepseek-v4.1-flash-free` |
| single request, new provider | 165 504 input tokens, answer correct, 6.2 s |
| oversized payload | 264K + 308K token payloads compacted automatically, secret retained |
| compaction chain | 3 consecutive compactions, secret retained, all `completed` |
| retry hook | 429 mock: 10 s -> 20 s -> 40 s backoff |
| auto-resume | fired after 3 retries, suppressed on hard 400 |
| stall detector | interrupt + resume on a hanging provider |
| scoping | plugin log lines for the new provider only, zero for the original |

## Files

```
plugin/resilience/index.ts   the OpenCode v2 plugin
opencode.snippet.jsonc       reference config fragment
scripts/apply-config.js      idempotent config merge + plugin copy (needs node)
install.ps1 / install.sh     convenience installers
INSTALL.md                   procedure written for an AI agent
```

## Free-tier note

The endpoint is OpenCode's own free inference gateway. Requests carry
`Authorization: Bearer public` plus the client's `x-opencode-client` header, and the gateway
only accepts them **from inside the OpenCode client** — that is why the provider is added as
`@ai-sdk/openai-compatible` rather than called with curl. Cost stays $0; there is no API key
to buy or leak.

## Troubleshooting

- **Model missing from the list** – check that the config file is valid JSON/JSONC and that
  the provider key is `flash1047`. Restart OpenCode fully (tray icon -> quit).
- **`400 Model is unavailable`** – you are hitting the gateway with a model id it does not
  know. The model key must stay `deepseek-v4.1-flash-free`; only `name` is cosmetic.
- **No plugin activity** – look for `setup` in `.omo/logs/resilience.jsonl` inside your
  project directory. If it is absent, the plugin path is wrong: it must be
  `~/.config/opencode/plugins/resilience/index.ts` (a directory containing `index.ts`).
- **Want the original back** – delete the `flash1047` provider block and the `resilience`
  plugin entry; nothing else was modified.
