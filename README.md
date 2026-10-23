# flash 1047 — Super Free

[![release](https://img.shields.io/github/v/release/ERETLY/opencode-flash-1047?label=release)](https://github.com/ERETLY/opencode-flash-1047/releases)
[![tests](https://img.shields.io/badge/tests-103%2F103-brightgreen)](#tests-and-evidence)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![opencode](https://img.shields.io/badge/OpenCode-2.x-black)](https://opencode.ai)

A free **310K-context** `deepseek-v4.1-flash-free` entry for **OpenCode 2.x**, plus the plugin that
keeps multi-hour sessions from dying, drifting, or quietly getting dumber.

**Version:** v1.6.1 · **Status:** stable — 103/103 unit tests, live-verified on OpenCode 2.1.3 ·
**Cost:** $0 · **Scope:** one provider, one model id, nothing else is touched.

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
```bash
# macOS / Linux
bash install.sh
```

Then quit OpenCode completely, reopen it, and pick **flash 1047 - Super Free**. Details in
[Quick start](#quick-start).

---

## Contents

1. [Who this is for](#who-this-is-for)
2. [This entry vs the stock entry](#this-entry-vs-the-stock-entry)
3. [What it fixes](#what-it-fixes)
4. [Speed expectations](#speed-expectations)
5. [Quick start](#quick-start)
6. [How a request flows](#how-a-request-flows)
7. [Context policy](#context-policy)
8. [Options](#options)
9. [Presets](#presets)
10. [Behaviour reference](#behaviour-reference)
11. [The log](#the-log)
12. [Tests and evidence](#tests-and-evidence)
13. [Troubleshooting](#troubleshooting)
14. [FAQ](#faq)
15. [Files](#files)
16. [Uninstall](#uninstall)
17. [Free-tier note and limits](#free-tier-note-and-limits)
18. [This release](#this-release)
19. [License](#license)

---

## Who this is for

- You use the **free** `deepseek-v4.1-flash-free` model in OpenCode and a long task (an hour or
  more) ends with a dead session, an early compaction, a lost thread, or the model inventing work.
- You want the **biggest window you can actually use** — 310 000 tokens measured, not the 200 000
  the stock entry claims.
- You want a plugin that **never swaps your model** and never silently changes the answer quality.

## Who this is not for

- **Hard reasoning problems.** This is a free Flash-tier model. It is good at bulk edits, refactors,
  test loops and long mechanical work; it is not a frontier model and will lose to one on design
  questions. If that is the job, pay for a better model.
- **Low latency.** A long session costs 10–30 s per model step, and one user message can be ~11
  steps. See [Speed expectations](#speed-expectations).
- **Not OpenCode.** The provider block is OpenCode-specific and the plugin is an OpenCode 2.x plugin.

## This entry vs the stock entry

Same model id, same weights, same $0. The difference is two things: **the declared window** and
**the plugin that manages it**.

### The numbers

| | stock `opencode` entry | this entry |
|---|---|---|
| model id | `deepseek-v4.1-flash-free` | same |
| price | $0 | $0 |
| declared context | 200 000 | **310 000** |
| where the client compacts | ~170 000 (limit − 15%) | **263 500** (85%) |
| usable before compaction | ~170k | **~263k** |
| measured gateway wall | 319 123 accepted / 325 760 rejected | the same wall, kept in mind |
| output | 32 000 | 32 000 |
| reasoning variants | low / high / max | low / medium / high / max |
| calibrated size estimate | no (`chars / 3.6`) | **yes, per model** |
| old tool output trimmed | no | **yes, with a marker** |
| dead-stream retry | the turn ends | **retried, up to 7** |
| resume after a failed turn | no | **yes** |
| post-compaction anchor | no | **yes** |
| task saved on disk | no | **`.omo/goal.md`** |
| model switching | — | **never** |

The 170 000 figure is not a defect of the model: the runtime compacts at `limit − max(15%, 16 000)`,
so a declared 200 000 costs ~93 000 tokens of working memory before the first summary. Declaring the
measured 310 000 is what buys those ~93 000 back.

### In a long session

| what happens | stock entry | this entry |
|---|---|---|
| a 200 000-character log lands in context | the next request is too big | the middle is elided with a marker, the turn survives |
| context reaches the compaction point | compacts at ~170k, early | compacts at 263.5k, with ~46k of headroom |
| the summary loses your wording | you re-explain | `goal.md` + the note carry your asks verbatim |
| after compaction | the session waits for you | one prompt continues the task, anchored on the goal |
| the stream dies at 90% | the turn fails | retried; pruned harder on the second failure |
| the summariser stream is truncated | compaction fails, the session stalls | backoff, then emergency trim: the session keeps working |
| context pressure | "keep replies short" | full quality, targeted reads, findings written down |
| the model itself | same quality per token | same quality per token |

### vs a paid model

| | this | a paid frontier model |
|---|---|---|
| cost | $0 | per token |
| window | 310k measured | usually 200k–1M, varies |
| hard reasoning | weaker | **stronger** |
| long mechanical work | **what it is for** | fine, but you pay |
| rate limits | shared free pool | your quota |

Practical split: use this for refactors, test loops, log hunting, migrations and anything long and
mechanical. Switch to a paid model when the problem is the thinking, not the typing.

## What it fixes

| symptom you have seen | cause | what this repo does |
|---|---|---|
| `400 context_length_exceeded` around 200k | the declared window is wrong | declares 310 000, measures real usage, calibrates per model |
| compaction fires every turn and fails | cooldown counted from the request, not the failure | backoff measured from the failure: 3 → 6 → 12 → 24 → 30 min |
| the session goes idle after compaction and waits for you | nothing continues the turn | auto-continue prompt + `.omo/goal.md` on disk |
| "the model forgot what I asked" | the summary paraphrased your requirements away | the compaction note carries your last four asks **verbatim**, and `goal.md` keeps a `## Requirements` section |
| the model gets lazy in long chats | pressure notes said "keep replies short, avoid re-reading" | notes now say: full quality, verify, use targeted reads, record findings |
| a stream dies mid-answer (`ECONNRESET`) | the free gateway closes it | transport retry, force-prune on the second failure |
| the whole session dies at ~250k | the summariser stream gets truncated | emergency trim: old tool output and old text are cut, the session keeps working |
| it looks like the model is "hanging" | hidden reasoning + retries + many steps | visible: `compact-backoff` / `retry` / `ctx` lines in `.omo/logs/resilience.jsonl` |

## Speed expectations

Measured on a real 250k-token session: 96 user messages, 1 047 assistant steps, 1 093 tool calls.

| | |
|---|---|
| model calls per user message | ~11 |
| generation per step, median / p90 | 10.4 s / 30 s |
| total generation time in that session | ~4 hours |
| context re-sent per step | ~155 000 tokens (cached) |

A step costs roughly what the context costs, so a fresh chat answers in seconds while a 250k
session costs 10–30 s per step. The plugin makes long sessions **survivable**, not **fast**: it caps
the context at 310 000, trims old tool output and stops compaction from storming.

Two practical notes:

- **Start a new session for a new task.** That resets the per-step cost from ~155k tokens to a few
  thousand. It is the single biggest speed lever there is.
- **`high` vs `max` is not a speed lever.** Measured medians differ by under 10%; pick the variant on
  quality, not on speed.

## Quick start

Requirements: OpenCode 2.x. The installers use Node.js or Python **only if present**; the manual path
needs neither.

```bash
git clone https://github.com/ERETLY/opencode-flash-1047.git
cd opencode-flash-1047
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
```bash
# macOS / Linux
bash install.sh
```

Then **quit OpenCode completely** (tray icon → Quit, not just closing the window) and start it again.
Pick **flash 1047 - Super Free** in the model list.

Verification, in order — if all three pass, the install is live:

| check | expected |
|---|---|
| model list | `flash1047/deepseek-v4.1-flash-free` appears next to the stock one |
| `.omo/logs/resilience.jsonl` in your project | a `setup` line with `"guarded":"flash1047/deepseek-v4.1-flash-free"` |
| after a few turns | `ctx` lines whose `used` tracks real usage, and no `compact-error` |

Custom config location:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ConfigDir "D:\tools\opencode"
```
```bash
node scripts/apply-config.js --dir "D:\tools\opencode"   # cross-platform merge, no shell
```

`install.sh` honours `XDG_CONFIG_HOME` as well as `$HOME`. For an AI assistant, hand it
[`INSTALL.md`](INSTALL.md) and say *"install this model"*.

## How a request flows

The plugin is three hooks and one event stream. Every mutation is applied to the **outgoing request
only**; the stored session is never rewritten.

```
 user prompt
     │
     ▼
 ┌─ session.context ─────────────────────────────────────────────┐
 │ 1. strip a pressure note left by a previous request           │
 │ 2. estimate size (ASCII 3.6 ch/tok, wide text 2.0 ch/tok)      │
 │ 3. used = estimate × cal        ratio = used / 310 000         │
 │ 4. clamp options.maxTokens so prompt + reply ≤ 318 000 − 4 000 │
 │ 5. prune stale tool output (≥ 70% of the window)               │
 │ 6. append one pressure note at the current level               │
 │ 7. record prevEst = size of what is actually about to be sent  │
 │ 8. if ratio ≥ 85% → session.compact()                          │
 └───────────────────────────────────────────────────────────────┘
     │
     ▼
   provider  ──(usage: input + cache.read + cache.write)──►  cal updated (EMA)
     │
     ▼
   session.idle / execution-failed  ──►  resume prompt, checkpoint, re-anchor
```

Why step 7 matters: the provider reports usage for the request that was **sent**. Recording
`prevEst` before pruning would make `cal = real / prevEst` shrink in proportion to the pruned share
(0.44 instead of 1.2 in the regression test), so every later decision would under-count and the 85%
trigger would fire far above the real ceiling. The estimate is therefore recorded after pruning, and
there is a dedicated test for it.

## Context policy

Thresholds are fractions of `contextLimit` (310 000 as shipped):

| level | value | tokens | what happens |
|---|---|---|---|
| `pruneSoft` | 70% | 217 000 | start eliding the middle of stale tool output |
| `warn` | 70% | 217 000 | note: work at full quality, prefer targeted reads, record findings |
| `compact` | **85%** | 263 500 | request compaction, then re-anchor |
| `hard` | 93% | 288 300 | last-resort note if compaction did not reduce usage |
| runtime auto | — | 270 000 | OpenCode's own compaction, kept as a safety net |

**The `buffer` contract.** OpenCode auto-compacts at `limit − max(15% of limit, 16 000)` = 263 500
by default, i.e. exactly where the plugin triggers. Setting `compaction.buffer: 40000` moves the
runtime to `310 000 − 40 000 = 270 000`, so the plugin compacts first and the runtime stays a
backstop below the real 319K wall.

**The `keep` contract.** `compaction.keep.tokens` and the plugin's `keep` **must be the same
number** (32 000 shipped). The runtime cannot summarise anything inside the keep window, so a
trigger below `keep` only produces `Nothing to compact yet`; the plugin detects that case and backs
off instead of asking again on every request.

Two invariants hold for any preset:

```
compact × limit  <  limit − buffer          (plugin triggers before the runtime)
keep            <  compact × limit          (there is something left to summarise)
```

Shipped: `263 500 < 270 000` ✔ and `32 000 < 263 500` ✔.

### Calibration, with numbers

One real sample arrives per completed step: `real = input + cache.read + cache.write`.

```
cal ← cal × (1 − w) + (real / prevEst) × w      w = 0.65 on a sharp shift, 0.4 otherwise
cal is clamped to [0.4, 2.5]
```

A first sample is taken raw (`calN = 0`), then smoothed. Guards: `prevEst ≥ 1 500`,
`real ≥ 1 000`, and `0.3 < real / prevEst < 3` — anything outside is a measurement artefact
(the step was retried, a tool returned early), not a calibration event. Samples are keyed by
assistant-message identity so parallel tool calls count once while a genuinely identical second
turn still counts.

### Pruning

Past `pruneSoft`, the middle of old tool results is replaced with head and tail plus an explicit
marker:

> `[omni-resilience] 41 233 chars were removed from the middle of this tool output by the client
> to protect the context window. You cannot see them - do not guess or reconstruct their contents.
> Re-run the tool with grep/offset/limit if you need that part again.`

At `compact` pressure the retained head/tail shrink further and only the last 6 tool results stay
intact. That is why a 200 000-character log does not have to end the session.

## Options

Every option is passed through `plugins[].options` in `opencode.jsonc`. Defaults shown are the
plugin's, and the shipped config overrides only `keep` and `contextLimit`.

| option | default | meaning |
|---|---|---|
| `onlyProviderID` | `flash1047` | the only provider this plugin ever touches |
| `onlyModelID` | `deepseek-v4.1-flash-free` | the only model id it ever touches |
| `contextLimit` | `310000` | must equal the provider's `limit.context` |
| `warn` | `0.7` | fraction where the first pressure note appears |
| `compact` | `0.85` | fraction where compaction is requested |
| `hard` | `0.93` | fraction for the last-resort note |
| `pruneSoft` | `0.7` | fraction where tool-output elision starts |
| `keep` | `15000` | must equal `compaction.keep.tokens`; floor becomes `keep + 3 000` |
| `keepRecent` | `12` | how many trailing messages pruning never touches |
| `ceiling` | `318000` | measured hard limit; reply reservation is clamped below it |
| `margin` | `4000` | headroom kept free for estimator error |
| `cooldownMs` | `180000` | minimum gap between compaction requests |
| `emergencyRatio` | `0.5` | after 2 failed compactions, the ratio above which old history is trimmed |
| `compactingTtlMs` | `120000` | watchdog: clear a `compaction.started` flag that never ends |
| `every` | `20` | checkpoint interval, in tool calls |
| `stallMs` | `900000` | no provider event for this long while the server says "running" → stall |
| `maxResumes` | `4` | resume prompts per user message |
| `maxTransportFails` | `7` | transport failures tolerated before giving up (6 retries, the 7th is final) |
| `resumeCooldownMs` | `120000` | minimum gap between resumes |
| `warnMode` | `"tail"` | `"tail"` appends the note after the history; `"system"` puts it in the system prompt |

## Presets

**Quality** (shipped) — multi-hour work where losing detail costs more than sending big requests.

**Balanced** — shorter sessions, smaller requests, fewer compactions:

| setting | quality | balanced |
|---|---|---|
| `compact` | **0.85** (263 500) | 0.90 (279 000) |
| `compaction.buffer` | **40 000** (auto at 270 000) | 15 500 (auto at 294 500) |
| `keep` / `compaction.keep.tokens` | **32 000** | 24 000 |
| `pruneSoft` | **0.70** (217 000) | 0.55 (170 500) |

**Focused** (experimental, unmeasured) — trades more frequent, lossy compactions for a shorter
working context: `warn 0.50`, `compact 0.65`, `hard 0.80`, `pruneSoft 0.55`,
`buffer 100 000` (auto at 210 000), `keep` unchanged. Compare it on one long task before adopting.

Why quality is the default: at 85% there is ~46 000 tokens of headroom against a one-shot
estimator error, `keep` 32 000 retains 8 000 more tokens verbatim across a compaction, and
pruning starts where there is still room rather than at 170 000. The cost is latency, not money.

## Behaviour reference

| mechanism | policy |
|---|---|
| **retry transport** | `1200 ms × attempt`, capped at 8 000 ms; force-prune on the 2nd failure; give up on the 7th |
| **retry 5xx** | `700 + 400 × count`, capped at 2 500 ms; 45 s budget per episode |
| **retry 429** | `3000 × 2^(count−1) × 0.6`, capped at 15 000 ms; 60 s budget |
| **not retried** | 4xx other than 408/409/425/429, own stall interrupts, `provider.invalid-request` |
| **fatal** | 4xx naming the model as unavailable/unknown, auth, permission, 401/403, no-route |
| **never** | model switching, silent failover, rewriting stored messages |
| **resume** | after an exhausted turn, quotes your task, max 4 per message, 2-minute cooldown |
| **stall** | 15 min without an event, verified against server state, then interrupt → verify → resume |
| **checkpoints** | `.omo/checkpoints/<session>.json` every 20 tool calls, on start/finish, around compaction |
| **re-anchor** | one system part after compaction: quotes the task, forbids restarting or inventing work |
| **goal file** | `.omo/goal.md` on every substantive message: the task, the last four asks verbatim, the last nudge |
| **compaction note** | appended as a **new user message** with the user's own words, paths with line ranges, commands, errors, last step, `.omo/state.md` |
| **compaction failure** | silence, not a retry: the cooldown is measured from the failure and doubles 3 → 6 → 12 → 24 → 30 min |
| **emergency mode** | after two failures: above `emergencyRatio` old tool output becomes 600/200 chars, old assistant text and reasoning 600 chars, the last six messages stay byte-identical, and a handoff note carries the goal plus `.omo/state.md` |

The compaction note is a new message on purpose. Adding a text part to a `tool` message makes the
request invalid on strict protocols (`OpenAI Chat: tool messages only support tool-result content
for now`), and appending to an assistant message puts instructions inside the model's own past
output. A fresh trailing user message is legal everywhere.

## The log

`.omo/logs/resilience.jsonl`, one JSON object per line, in the project directory. The `at` field is
the event name:

| `at` | when | useful fields |
|---|---|---|
| `setup` | plugin loaded | `plugin` (version), `pid`, `guarded`, `modelSwitching`, option values |
| `compact-backoff` | a compaction failed | `fails`, `emergency`, `nextTryMs` |
| `emergency-trim` | old history was cut because compaction is unavailable | `saved`, `messages`, `used`, `ratio`, `fails` |
| `setup-duplicate` | a simultaneous second load of the same plugin for this root | `plugin`, `pid`, `note` — hooks stay registered once |
| `ctx` | first 12 requests only | `used`, `est`, `cal`, `ratio`, `msgs`, `toolChars` |
| `prune` | tool output elided | `saved`, `messages`, `forced` |
| `calibrate` | a real sample was accepted | `real`, `estimate`, `cal`, `n`, `jump` |
| `compact-request` / `compact-admitted` / `compact-error` | compaction lifecycle | `used`, `error`, `empty` |
| `compact-skip` | trigger fired but was skipped | `why` = `below-keep-window` \| `no-history` |
| `compacting-watchdog` | a `started` event never arrived | `ageMs` |
| `compaction-note` | note appended | `injected`, `state`, `target` |
| `warn` / `warn-rearm` | level entered / log re-armed after a drop | `key`, `ratio`, `mode` |
| `note-strip` | a stale pressure note was removed | `removed` |
| `anchor` | post-compaction re-anchor injected | `task` |
| `retry*` | `retry-hook`, `retry`, `retry-fatal`, `retry-giveup` | `status`, `reason`, `delay`, `budget` |
| `transport-fail` | stream died mid-flight | `count`, `status` |
| `resume*` | `resume`, `resume-sent`, `resume-skip`, `resume-capped` | `reason` |
| `stall*` | `stall`, `stall-skip`, `stall-resolved` | `idleMs`, `status` |
| `checkpoint` | checkpoint written | `reason` |

A healthy long session looks like: steady `calibrate` lines with `cal` between 0.9 and 1.4, one
`warn` per level climb, `compact-request` around 263 500, `compaction-note`, then
`compact-admitted`.

**Is the version I installed the version that is running?** Look at the `setup` line:

```json
{"at":"setup","plugin":"1.6.1","pid":17136,"guarded":"flash1047/deepseek-v4.1-flash-free", ...}
```

A `setup` line **without** `plugin` is a different build still held in memory. The runtime re-reads the
plugin when it starts a server instance for a project, which usually happens on its own (a new
`setup` line with the new version appears after the file changes); if it still shows the old
version, quit the app completely and reopen it. No `setup` line for your session at all is the other,
more common case: the session is not on `flash1047/deepseek-v4.1-flash-free`, so the plugin is doing
exactly what it promises — nothing.

## Tests and evidence

```bash
node --experimental-strip-types test/resilience.test.mjs   # Node >= 22.6, no dependencies
```

`test/resilience.test.mjs` drives the plugin through a fake session and a fake event stream, so
behaviour is asserted rather than eyeballed. **Last run: 103 / 103 passed.**

| area | asserted |
|---|---|
| scope | another provider/model is never touched, resumed or anchored |
| pruning | stale output shrinks, marker is explicit, recent messages intact, second pass is a no-op |
| estimator | Cyrillic counts as wide text, not ASCII |
| calibration | raw first sample, smoothed second, faster jump on a shift, decisions use `cal`, learned against the pruned request, one sample counted once, identical sample on a new message still counted |
| pressure note | appended after the history, system prompt untouched, logged once per level, not counted as history, `warnMode: "system"` works, a persisted note does not stack, a stale note is stripped, the level re-arms |
| thresholds | 82% does not compact, 85% does, reply reservation shrinks near the ceiling |
| compaction safety | keep floor tracks the option, no-history sessions skip, `Nothing to compact yet` does not hot-loop, a lost event cannot wedge the flag |
| compaction note | exactly one appended user message, existing messages byte-identical, task/tools/files/last step preserved, the user's own words, a ranged read as `file:from-to`, commands verbatim, the anti-paraphrase instruction |
| compaction recovery | a failure raises the backoff (720 000 ms after two), emergency mode turns on, no request while the backoff holds, old assistant text is cut, the handoff note carries the task, a successful compaction resets the mode |
| goal file | the task is written, a nudge does not replace it, every ask is kept verbatim |
| re-anchor | one system part, quotes the task, injected once |
| retry | 5xx/429/transport retried, invalid-request not retried, gives up after 5 resets, "Model is unavailable" not retried and not resumed |
| switching | `switchModel` is never called |
| resume | fires after a failed turn, quotes the task, respects cooldown and `maxResumes` |
| logging | `setup` records the guarded entry and `modelSwitching: disabled` |

Measured against the author's **OpenCode 2.1.2**:

| test | result |
|---|---|
| window boundary | 319 123 accepted, 325 760 rejected (`400 context_length_exceeded`) |
| reasoning effort wire format | 4/4 variants sent the matching `reasoning_effort` body field |
| reasoning effort behaviour | 12/12 correct; `max` highest mean reasoning (494.7 vs 429.0 at `low`) |
| forced compaction, live | `limit=20 000`, usage 48 532, 3 large reads → `compact-request` → `compaction-note` → `started` → `delta` → `ended` → checkpoint → answer |
| scoping | a non-guarded session produced only a `setup` line |
| model switching | never — `switchModel` not called |

Run live on **OpenCode 2.1.3**, v1.6.1, author's install:

| observation | result |
|---|---|
| compactions | two completions in one session (summary 5 567 and 6 633 chars), no `compact-backoff` between them |
| emergency trim | zero `emergency-trim` lines in a 250k-token session |
| pruning volume | 1 499–3 099 chars per request — tool output only, history untouched |
| plugin reload | a `setup` line with `plugin: 1.6.1` appeared after the file changed, without restarting the app |
| session footprint | 1 047 model steps, 1 093 tool calls, 1.29 M chars of hidden reasoning, 145k chars of visible text |

**What is and is not covered.** Every behaviour above is unit-tested, and the v1.6.x line has run
live for hours on 2.1.3: compaction, pruning, both kinds of note, retries, goal file. Two things
stay environment-dependent and are deliberately not asserted: gateway latency and how often the
summariser stream gets truncated, because both move with the free pool's load. The plugin reacts to
them (transport retry, compaction backoff, emergency trim) instead of pretending to predict them.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| **compacts on every turn** | `contextLimit` ≠ provider `limit.context`, or `keep` ≠ `compaction.keep.tokens`. The log shows `compact-error: Nothing to compact yet`. |
| **runtime compacts before the plugin** | `compaction.buffer` too small; 40 000 puts runtime auto at 270 000, above the plugin's 263 500. |
| **model missing from the list** | invalid JSONC, wrong provider key (must be `flash1047`), or OpenCode not fully restarted. |
| **`400 Model is unavailable`** | the model key must stay `deepseek-v4.1-flash-free`; only `name` is cosmetic. |
| **no plugin activity** | no `setup` line → wrong path. It must be `~/.config/opencode/plugins/resilience/index.ts`, a **directory** containing `index.ts`. |
| **`ECONNRESET` after HTTP 200** | the free gateway closed the stream. Handled: transport retry, force-prune on the 2nd, then a clean failure instead of a hang. |
| **`429 Too Many Requests`** | the free pool is shared and the plugin already waits it out (backoff up to 15 s per attempt, 60 s budget). If you are behind a shared address - VPN, corporate NAT, campus - the limit may be counting other people's traffic rather than yours, and another network can clear it. The client never bypasses anything: it only waits and retries. |
| **a long chat feels slow** | one user message costs ~11 model calls, each re-reading the whole context: measured 10–30 s per step at 250k tokens. Start a new session for a new task. The plugin caps and trims; it does not make the model faster. |
| **`compact-backoff` with a growing `fails`** | the gateway keeps truncating the summariser. Nothing to fix: the session continues through the emergency trim until a compaction gets through. |
| **compaction fails with `provider.invalid-request`** | the note was appended to the trailing tool message. Use the current `plugin/resilience/index.ts` - the note must be a new user message. |
| **resume prompt keeps appearing** | a turn genuinely ended with no answer. Check `stall*` / `resume-skip` lines. |
| **every log line appears twice** | the plugin is loaded twice (directory scan + `plugins` config entry). The second load logs `setup-duplicate` and does not register hooks; if doubles persist, check `plugin` in the `setup` line - it must match the version you installed. |
| **context grows by ~50 tokens per request** | that is the pressure note while a level holds; it is stripped before the next request, so it does not accumulate. |

## FAQ

**Does it switch models or silently fall back?**
No. `switchModel` is never called; a test fails the suite if it ever is. If the model dies, you get a
retry, a resume prompt, or a clean error — not a different model.

**Does it cost anything?**
No. The endpoint is OpenCode's free gateway; there is no key to buy.

**Will it break my stock `opencode/deepseek-v4.1-flash-free` entry?**
No. It adds a separate `flash1047` provider and never edits the stock block. Uninstall removes only
what this repo added.

**Why 310 000 and not 320 000?**
Because 319 123 was accepted and 325 760 was rejected by the gateway. 310 000 leaves room for
estimator error while staying under the wall, and the plugin clamps the reply reservation below
318 000 anyway.

**The window says 310 000 but my session compacted at 263 500.**
That is intentional: compaction at 85% keeps ~46 000 tokens of headroom, so one mis-estimated
request cannot blow the request up. Raise `compact` if you prefer living closer to the edge.

**Does it work on Windows, macOS and Linux?**
Yes. `install.ps1` for Windows, `install.sh` for macOS/Linux, and `scripts/apply-config.js` if you
prefer no shell at all.

**Can I use it with a different model?**
The provider block is specific to `deepseek-v4.1-flash-free` and the plugin is scoped to
`flash1047/deepseek-v4.1-flash-free`. Point it at something else and it does nothing — by design.

**Why does output sometimes stop mid-sentence and then continue?**
A dead stream gets retried. The retry is visible in the log as `retry` / `transport-fail`; it is not
a silent answer change.

**Is this safe to run for a whole workday?**
That is what the test suite and the live sessions target: hours of work with compaction, pruning and
retries. The failure modes it cannot remove are the free pool's latency and load.

## Files

```
plugin/resilience/index.ts    the OpenCode v2 plugin
instructions/long-session.md  long-session rules, loaded via the `instructions` array
test/resilience.test.mjs      regression suite (103 assertions, no dependencies)
opencode.snippet.jsonc        reference config fragment (provider + plugin + compaction + instructions)
scripts/apply-config.js       idempotent config merge + plugin and rules copy (node)
install.ps1 / install.sh      convenience installers
INSTALL.md                    procedure written for an AI agent
CHANGELOG.md                  what changed and why, per version
LICENSE                       MIT
```

## Uninstall

1. Quit OpenCode.
2. Remove the `flash1047` provider block, the `plugins` entry with `"./plugins/resilience"`, and —
   if you only added it for this install — the tuned `compaction` block.
3. Remove `~/.config/opencode/plugins/resilience/` and, if you added it,
   `~/.config/opencode/instructions/long-session.md` plus its `instructions` entry.
4. Delete the stock entry's copies of anything you changed. The stock
   `opencode/deepseek-v4.1-flash-free` entry is never modified by this repo.

Nothing else is touched: no global state, no environment variables, no background process.

## Free-tier note and limits

The endpoint is OpenCode's own free inference gateway. Requests carry
`Authorization: Bearer public` plus the client's `x-opencode-client` header, and the gateway only
accepts them **from inside the OpenCode client** — which is why the provider is added as
`@ai-sdk/openai-compatible` instead of being called with curl. Cost stays $0; there is no key to
buy or leak.

Limits worth knowing before you build on it:

- the free pool is shared, so latency and truncation rates vary with load;
- the model is Flash-tier: excellent for mechanical work, weaker on hard reasoning;
- the window is measured, not guaranteed — if the gateway changes, watch `ctx` and `calibrate` lines
  and treat them as the source of truth.

## This release

**v1.6.1 — stable.** One build; nothing about history is needed to use it.

- A compaction failure is no longer retried into a storm: the cooldown is measured from the failure
  and doubles 3 → 6 → 12 → 24 → 30 min.
- After two failures, emergency trim keeps the session working: old tool output and old assistant
  text are cut, the last six messages stay intact, and a handoff note carries the goal and
  `.omo/state.md`.
- The compaction note carries your last four asks verbatim, file paths with line ranges, the exact
  commands and error lines, and forbids paraphrasing your requirements.
- `.omo/goal.md` keeps the task, those asks and your last nudge on disk.
- After compaction the session continues by itself instead of waiting for "continue".
- Context pressure asks for full quality and targeted reads, not short answers.
- 103 assertions, live-verified on OpenCode 2.1.3.

## License

MIT — see [`LICENSE`](LICENSE).
