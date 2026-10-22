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
| reasoning effort | low / high / max | **low / medium / high / max** |
| resilience plugin | no | **yes** |

Measured on the live free endpoint: 319 123 tokens accepted, 325 760 rejected with
`400 context_length_exceeded`. 310 000 leaves headroom for tool schemas and the reply.

## Reasoning effort

The model entry declares `low`, `medium`, `high` and `max` variants. Pick one in the model
picker (or in the session's model settings); the plugin does not touch it. Verified on 2.0.32:
selecting `max` sends `"reasoning_effort": "max"` in the request body to the gateway.

If a variant is missing from the picker, the `variants` object is missing from the model entry —
restart OpenCode after adding it.

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
- **Compaction note** – adds the user's task, tool count, recent tool names and `.omo/state.md`
  to the compaction request so the summary keeps operational state. It is appended as a **new
  user message**; the plugin never rewrites an existing message. Rewriting a `tool` message made
  the whole request invalid on strict protocols (OpenAI Chat: *tool messages only support
  tool-result content for now*), and appending to an assistant message put instructions inside
  the model's own past output.
- **Post-compaction re-anchor** – the first request after a successful compaction gets one system
  part that quotes the task verbatim and forbids restarting, re-asking or inventing new work.
  This is the part that keeps a 3-hour task from silently turning into something else.
- **Checkpoints** – writes `.omo/checkpoints/<session>.json` every 20 tool calls, on
  execution start/finish, and around compactions.
- **Retry policy** – 429/408/409/425/5xx/transport errors retried with backoff. A 5xx such as
  `Upstream request failed: Endpoint is unavailable` is retried fast (1s, 2s, 4s, capped at 5s),
  a stream that dies mid-flight (`provider.transport` / `ECONNRESET`, HTTP 200 already received)
  at 1.5s, 3s, 4.5s ... capped at 8s, and only 429/rate-limit gets the long 5s -> 60s backoff.
  After 5 transport failures the plugin stops extending the retry window instead of hanging for
  minutes. It also force-prunes stale tool output on the second reset, since a huge request is
  the usual reason the gateway drops the stream. **It never switches the session model**: a 429
  or 5xx only changes the backoff. If the endpoint stays dead, the turn fails and the resume
  prompt says so, instead of quietly continuing on a different model.
- **Auto-resume** – after retries are exhausted (and the error is not auth/model-fatal) the
  session is resumed with a "continue where you left off" prompt that quotes your task back,
  max 4 times per user message.
- **Stall detection** – no provider event for 15 minutes while the server still reports the
  session as running, no pending tools and no finished assistant answer -> interrupt, then
  resume. Every check is verified against the real session state first, so an idle session can
  never be woken up by a stale timer.
- **No protocol injection** – the long-session rules live in
  `~/.config/opencode/instructions/long-session.md`, which OpenCode already loads into the system
  prompt for every session. An earlier version injected a second copy per session; that burned
  tokens and drifted from the file, so it was removed.

The plugin never touches your other models: it exits immediately unless the session is exactly
`flash1047/deepseek-v4.1-flash-free` (provider **and** model id are checked, and the default is
that pair even if the config options are missing).

## Verified on 2.0.32

| test | result |
|---|---|
| model list | `flash1047/deepseek-v4.1-flash-free` + `opencode/deepseek-v4.1-flash-free` |
| single request, new provider | 165 504 input tokens, answer correct, 6.2 s |
| oversized payload | 264K + 308K token payloads compacted automatically, secret retained |
| compaction chain | 3 consecutive compactions, secret retained, all `completed` |
| retry hook | 429 mock: 10 s -> 20 s -> 40 s backoff |
| transport retry | socket reset mid-stream: detected, retried 1.5s/3s/4.5s, gives up after 5 |
| 503 retry | two `Endpoint is unavailable` answers: recovered in 4.5s end-to-end |
| auto-resume | fired after 3 retries, suppressed on hard 400 |
| resume guard | failed turn that already produced an answer -> no resume prompt |
| stall detector | verified against session state; hanging provider -> interrupt + resume |
| reasoning variants | `low/medium/high/max` exposed, `reasoning_effort` sent on the wire |
| scoping | plugin log lines for the new provider only, zero for the original |
| model switching | never – `switchModel` is not called on repeated 429/5xx |
| compaction note | appended as a fresh user message; existing request messages stay byte-identical |
| live CLI run | `echo hi` tool call + answer on 2026-10-22, plugin loaded, 0 errors, checkpoint written |

## Tests

`test/resilience.test.mjs` drives the plugin through a fake session and a fake event stream, so
behaviour is asserted instead of eyeballed. No dependencies; Node >= 22.6 strips the TypeScript
on import.

```bash
node --experimental-strip-types test/resilience.test.mjs
```

Last run (2026-10-22, plugin as shipped): **34 / 34 passed**

| area | what is asserted |
|---|---|
| scope | another provider/model is never touched, never resumed, never anchored |
| pruning | stale tool output shrinks, marker is explicit, recent messages stay intact, a second pass is a no-op |
| compaction note | exactly one appended user message and every existing message stays byte-identical — the exact shape that used to fail with `OpenAI Chat tool messages only support tool-result content for now` |
| re-anchor | one system part after compaction, quotes the task, injected only once |
| retry | 5xx / 429 / transport retried, `provider.invalid-request` not retried, gives up after 5 resets |
| switching | `switchModel` is never called |
| resume | fires after a failed turn, quotes the task, respects cooldown and `maxResumes` |
| logging | setup records the guarded entry and `modelSwitching: disabled` |

## Files

```
plugin/resilience/index.ts   the OpenCode v2 plugin
test/resilience.test.mjs     regression suite (34 assertions, no deps)
opencode.snippet.jsonc       reference config fragment
scripts/apply-config.js      idempotent config merge + plugin copy (needs node)
install.ps1 / install.sh     convenience installers
INSTALL.md                   procedure written for an AI agent
CHANGELOG.md                 what changed in v1.1.0
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
- **`Connection lost while reading the response: ECONNRESET`** – the free gateway closed the
  stream after HTTP 200. It is upstream, not your machine and not the config; it happens on the
  paid DeepSeek entries too. The plugin retries transport failures up to 5 times, force-prunes
  stale tool output on the second one, and then lets the turn fail instead of hanging.
- **Compaction fails with `provider.invalid-request` / `OpenAI Chat tool messages only support
  tool-result content for now`** – an older copy of the plugin appended the compaction note to
  the trailing tool message. Update `plugin/resilience/index.ts` to the current version; the
  compaction then retries and completes.
- **Resume prompt keeps appearing** – that only happens when a turn really ended with no answer.
  If you see it on a finished turn, check `.omo/logs/resilience.jsonl` for `stall` /
  `stall-skip` / `resume-skip` lines and update to the current plugin version.
- **Want the original back** – delete the `flash1047` provider block and the `resilience`
  plugin entry; nothing else was modified.
