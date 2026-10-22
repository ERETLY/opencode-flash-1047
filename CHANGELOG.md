# Changelog

## v1.3.3 – 2026-10-22

One real defect, found in the live log.

### Fixed

- **A simultaneous double load registered the hooks twice.** OpenCode loads `plugins/*/index.ts`
  from the directory scan *and* the `plugins` entry in `opencode.jsonc` (the only way to pass
  options in), so on some startups `setup` runs twice about a millisecond apart. The state map,
  the event subscription and the stall timer were already shared per root; `ctx.session.hook(...)`
  was not, and the runtime does not de-duplicate it. In that state every request went through the
  context/prompt/compaction/retry hooks **twice**: retry counters advanced twice per failure, log
  lines came in pairs, and the pressure note was appended twice (then stripped and re-appended by
  the second copy). A second `setup` for the same root within 3 s of the previous one now logs
  `setup-duplicate` and returns before touching the hook registry.
- **The window is short on purpose.** A plugin load that happens later (minutes, or a different
  session) is not a duplicate: hooks may be registered per session, and skipping a later
  registration would silently disable the plugin for that session. Three seconds covers
  loader-induced duplicates and nothing else.

### Tests

78 assertions (was 75). Three cover the guard: the simultaneous load is skipped, it is logged, and
a later load for the same root still registers (so the fix cannot disable the plugin).

## v1.3.2 – 2026-10-22

Observability only, no behaviour change.

### Added

- **`setup` now stamps `plugin` and `pid`.** After an upgrade the only honest answer to "is the
  version I installed the version that is running?" used to be a file hash. The setup line in
  `.omo/logs/resilience.jsonl` now carries the plugin version and the process id, so a stale
  process is visible in one line. A `setup` line without `plugin` means the old build is still
  loaded: the runtime holds the plugin in memory, so only a full restart of the server picks up a
  new file.

## v1.3.1 – 2026-10-22

Hardening on top of v1.3.0. No behaviour change for a fresh session; the differences only show up
when the runtime keeps what the plugin mutates. Unit-tested (74 assertions).

### Fixed

- **The tail pressure note could stack up.** v1.3.0 appended the note to `event.messages` on every
  request and assumed the array was discarded afterwards. If the runtime keeps it (or replays it),
  each step adds another note: the context grows by a message per request and the note itself
  inflates the estimate that decides when to compact - the opposite of what the plugin is for. Any
  pressure note found at the start of the request is now removed before measuring, then exactly one
  is appended. The compaction note and the post-compaction anchor are untouched: they share the
  prefix but not the "Automatic note" wording.
- **`warnMode: "system"` pushed a copy per request.** The old code pushed once per level; v1.3.0
  made it unconditional, so the system prompt could collect duplicates. Identical text is now
  pushed once.
- **The calibration sample key was too coarse.** `${real}|${prev}` merged two different turns that
  produced the same numbers (identical size, identical reply) into one sample, so `cal` stopped
  following the session. The key now carries the identity of the assistant message the usage came
  from, which keeps the parallel-tool dedup without dropping a real second sample.
- **The level log never re-armed.** `marks` was permanent, so after the context dropped (compaction,
  prune) and climbed again, nothing was logged and the second climb looked healthy. The marks are
  cleared once the ratio falls below `warn - 5%`.
- **`compact-skip` history count is measured before the note.** `msgs.length - tailAdded` is
  replaced by a length taken right after stripping, so the number is correct even when several
  notes were present.

### Tests

- 68 -> 74 assertions: persisted note does not stack, stale note is stripped, strip is logged,
  system mode does not duplicate, level re-arms, identical sample on a new message is counted.
  Run against v1.3.0, six of them fail; against v1.3.1 all pass.

## v1.3.0 – 2026-10-22

Fixes found in a code review of v1.2.0. Unit-tested (68 assertions); not yet re-run against a
live OpenCode session.

### Fixed

- **Calibration was learned against the wrong request.** `prevEst` was recorded *before* pruning,
  while the provider reports usage for the pruned request that was actually sent. Once pruning
  started, `cal = real / prevEst` shrank in proportion to the pruned share (0.44 instead of 1.2 in
  the regression test), and every later decision used `estimate * cal` on top of an already
  smaller estimate, so it under-counted by the same share. The 85% trigger then fired far above
  the real ceiling and only the runtime safety net stood in the way. `prevEst` is now taken at the
  end of the context hook, after pruning and after the pressure note.
- **One real sample was counted several times.** Parallel tool calls and the execution-end event
  all read the same last assistant message and each ran an EMA update. A sample is now counted
  once.
- **The context-pressure note lived for one request and broke the prefix cache twice.** It was
  pushed into the system prompt once per level, so the model saw it for a single step and the
  system prompt changed twice (when it appeared and when it vanished). It is now appended as the
  last message of every request while the level holds, which leaves the cached prefix untouched.
  `warnMode: "system"` restores the old placement. The note also says it is automatic and not
  from the user, and tells the model to keep working on the task.
- **A wrong model id was retried for the whole backoff budget.** `400 Model is unavailable`
  matched the generic `unavailable` pattern, and the fatal pattern `model.unavailable` matched
  exactly one character between the words, so it did not catch the real message either. A 4xx
  that names the model as unavailable or unknown is now fatal: not retried, not resumed.
- **`install.sh` ignored `XDG_CONFIG_HOME` in its node fallback.** The plugin was copied to the
  XDG directory while `apply-config.js` edited `~/.config/opencode`. It now gets `--dir`.

### Added

- **`instructions/long-session.md`** and the `instructions` entry in the snippet, INSTALL.md and
  all three installers. OpenCode v2 loads only `AGENTS.md` on its own, so a file that is not
  listed in `instructions` is never read; v1.1.0 removed the plugin's own injection on the
  assumption that it was. The entry is a `~/` or absolute path (relative entries are resolved from
  the workspace upward). An existing edited copy is never overwritten and the entry is never
  added twice.
- **Focused preset (experimental)** in the README: compact at 65%, buffer 100 000. Not measured.
- **Tests:** 53 -> 68 assertions (calibration after pruning, single-count samples, tail note,
  `warnMode`, history detection, wrong model id).

### Changed

- README: the paragraph about `compaction.buffer` still said 15 500 (and a 270 000 trigger that
  15 500 does not give); it now describes the shipped 40 000. Added the caveat that the "auto at"
  numbers assume the runtime triggers at `limit - buffer`.

## v1.2.0 – 2026-10-22

Quality defaults for huge, multi-hour tasks. Behaviour is unchanged for anyone who already
passes explicit options; this changes what a fresh install gets.

### Changed

- **Shipped preset is now `quality`** (was `balanced`):
  - `compact: 0.85` (263 500 of 310 000) instead of 0.90;
  - `compaction.buffer: 40000` (runtime auto at 270 000) instead of 15 500;
  - `keep: 32000` and `compaction.keep.tokens: 32000` instead of 24 000;
  - `pruneSoft: 0.70` (217 000) instead of 0.55 (170 500).
- **Plugin `DEFAULTS` match the preset**: `compact 0.85`, `pruneSoft 0.70`. `keep` stays
  15 000 because that is OpenCode's own default when `compaction.keep.tokens` is unset; the
  installers set 32 000 in both places.
- README, INSTALL, `opencode.snippet.jsonc`, `install.ps1`, `install.sh` and
  `scripts/apply-config.js` all emit the quality preset, so a reinstall no longer resets a
  long-session setup back to the balanced numbers.

### Why

- 85% keeps ~46 000 tokens of headroom for a one-shot estimator error; at 90% the same error
  can push a request past the measured 319 123-token ceiling.
- 32 000 verbatim after compaction keeps 8 000 more tokens of real work than 24 000.
- Pruning at 217 000 instead of 170 500 stops discarding file contents while there is still
  plenty of room.

### Verified

- 53/53 regression assertions.
- `apply-config.js` and `install.ps1` merges on throwaway config dirs: original providers and
  foreign plugin entries preserved, correct quality block produced.
- Live setup: `limit 310000, compact 0.85, keep 32000, keepFloor 35000`.

## v1.1.1 – 2026-10-22

Compaction stops fighting itself, the context estimate stops lying on wide text, and the
reasoning variants are proven at the wire, not assumed.

### Fixed

- **Compaction storm (the big one).** If `compaction.keep.tokens` was larger than the plugin's
  `contextLimit * compact`, the plugin asked for compaction below the runtime's keep window,
  OpenCode answered `Nothing to compact yet`, and the old error handler reset the 3-minute
  cooldown to zero. The next request asked again — compaction on every turn, forever. Now:
  - the floor is `max(18 000, keep + 3 000)` and `keep` is an explicit plugin option that must
    match `compaction.keep.tokens`;
  - a `Nothing to compact yet` rejection keeps the cooldown and increments `compactEmpty`;
  - a watchdog clears a `compacting` flag whose `compaction.ended` event never arrives, so a
    lost event cannot disable compaction permanently either.
- **Runtime auto-compaction raced the plugin.** OpenCode's default threshold is
  `limit - max(15%, 16 000)` = 263 500 on a 310K window, i.e. 85%, so the runtime compacted
  before the plugin's 90% trigger. The shipped config sets `compaction.buffer: 15500`
  (runtime auto at 294 500) and `compaction.keep.tokens: 24000`, aligned with `options.keep`.

### Changed

- **Compaction trigger is 90%** (279 000 of 310 000), up from 85%. The runtime keeps the last
  24 000 tokens verbatim and summarises the older ones.
- **Wide-text aware estimator.** ASCII is counted at 3.6 chars/token, Cyrillic/CJK/emoji at
  2.0 chars/token. A single ASCII divisor undercounted Russian prompts by ~45%.
- **Adaptive calibration.** Real usage (`input + cache.read + cache.write`) is learned per
  step; the EMA uses weight 0.65 when the content mix shifts by more than 30% and 0.4
  otherwise, clamped to 0.4–2.5.
- **Richer compaction note.** It now carries files touched (`filePath/path/file/filename/target`),
  the tools used, the last visible assistant step and `.omo/state.md`, in addition to the task
  and tool count. Still appended as a new user message; existing messages are byte-identical.
- **Tests grew from 34 to 53 assertions**, including the exact storm regression, the keep-floor
  contract and the lost-event watchdog.

### Verified

- **Reasoning effort on the wire (OpenCode 2.1.2):** a capturing proxy in front of the provider
  recorded `reasoning_effort: "low" | "medium" | "high" | "max"` for the four variants. 12 runs
  of the same puzzle all answered correctly; `max` had the highest mean reasoning tokens
  (494.7 vs 429.0 low), though the sample is noisy.
- **Forced live compaction:** `contextLimit=20 000`, real usage 48 532, three large reads
  (109 170 tool chars) -> `compact-request` -> `compaction-note` (`user:new`) ->
  `compaction.started` -> `delta` -> `ended` -> post-compaction checkpoint -> `DONE-C`.
- **Isolation:** a run on another provider produced only a `setup` log line and zero session
  events (the provider itself had no balance, which is irrelevant to the scoping result).

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
