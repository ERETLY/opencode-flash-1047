# Changelog

## v1.1.0 – 2026-10-22

Boring on purpose: no model switching, no duplicated protocol text, and the task survives every
compaction. This release is about removing ways the plugin could quietly make a session worse.

### Fixed

- **Compaction used to die with `provider.invalid-request`.**
  `OpenAI Chat tool messages only support tool-result content for now` was the visible symptom:
  the compaction hook appended its note to the last message of the request, and when that message
  was a `tool` message the whole request became invalid on strict protocols (OpenAI Chat,
  Anthropic Messages). The note is now appended as a **new user message** and no hook ever
  rewrites an existing message.
- **The first user prompt of a session was never recorded.** The `prompt` hook checked the scope
  before the session model was known, so it returned early — and resume/compaction notes then had
  no task text to preserve. Hooks that can fire before the first request now resolve the model
  first.
- **Pruning marker wording.** It claimed the full output "is on disk", which is not always true.
  It now states plainly that the text was removed client-side and must not be guessed.

### Removed

- **Model failover** (`failover` pool, `switchAfter`, `maxSwitches`, `rateCooldownMs`,
  `deadCooldownMs`, `restoreAfterMs`, `restoreOnNewTurn`, `fallback`, `fallbackAfter`,
  `pickNext`, `switchTo`, `restore-primary`). It silently replaced the model the user picked with
  whatever answered, changing window size, reasoning shape and quality mid-task. It fired 3 times
  in two days of real use. A 429 or 5xx now only changes the backoff; a dead endpoint fails the
  turn and the resume prompt surfaces it.
- **Per-session long-session protocol block.** OpenCode already loads
  `~/.config/opencode/instructions/long-session.md` into the system prompt for every session
  (verified against the instruction blobs in `opencode.db`), so the injected copy only burned
  tokens and drifted from the file.
- **`prune-check` debug logging** (one line per pruning evaluation, ~250 lines in two days).

### Added

- **Post-compaction re-anchor.** The first request after a successful compaction gets one system
  part quoting the user's task verbatim: continue from `.omo/state.md`, do not restart, do not ask
  the user to repeat anything, do not invent new work.
- **Recent tool trace** in the compaction note (last 6 tool names), so the summary keeps what the
  agent actually did, not just a count.
- **Resume prompt quotes the task** (`Your task, verbatim from the user: "..."`), so a resumed
  turn cannot drift into a different job.
- **Hard scope.** The plugin is guarded to `flash1047/deepseek-v4.1-flash-free` by default (both
  provider and model id), so dropping the config options cannot widen it to every model.
- **`test/resilience.test.mjs`** — 34 assertions, no dependencies, run with
  `node --experimental-strip-types test/resilience.test.mjs`. It drives the plugin through a fake
  session and a fake event stream, including the exact message shape that broke compaction.

## v1.0.0

Initial release: tool-output pruning, proactive compaction, compaction note, checkpoints, retry
policy, auto-resume, stall detection, model failover, protocol block.
