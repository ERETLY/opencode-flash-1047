# Changelog

## v1.7.1 – 2026-10-28

Goal files moved into `.omo/goals/`, and the ones already on disk are moved with them.

### Changed

- **One folder for goals.** `.omo/goals/<sessionID>.md` per chat, with `.omo/goals/latest.md` as a
  mirror of the last active session. Every prompt that points at the goal uses the new path.
- **Existing goals are adopted at startup.** `.omo/goal.<id>.md` is renamed into the folder; the old
  single `.omo/goal.md` is copied to `<sessionID>.md`, with the session read from its own footer,
  and to `latest.md`. Nothing is overwritten: if the destination exists, the old file is left alone.
  A chat that is already running therefore finds its task at the new path on the next compaction.
- The migration logs `goals-migrated` with the file count, so it is visible rather than implied.

### Tests

142 assertions (was 139): a legacy per-session file is moved into `.omo/goals` with its content
intact, and the old `goal.md` is adopted for its session and as `latest.md`.

## v1.7.0 – 2026-10-27

The goal file is per session, so two chats in one folder cannot overwrite each other.

### Fixed

- **goal.md was one file per directory.** Two chats in the same folder wrote the same path, and
  after a compaction the older chat was told to `read .omo/goal.md` - which by then held the other
  chat's task. The goal is now written to `.omo/goal.<sessionID>.md`, and every reference follows
  it: the compaction anchor, the earlier-additions hints, the resume prompt and the auto-continue
  prompt. `.omo/goal.md` is still written as a mirror of the last active session, so anything that
  reads the old path keeps working.

### Changed

- Dead state-file plumbing left over from 1.6.10 removed (two empty `stateText` blocks and the
  `state` field in the compaction log line).

### Tests

139 assertions (was 137): a per-session copy exists and matches the mirror, and the auto-continue
prompt points at the session file.

## v1.6.10 – 2026-10-27

The plugin no longer tells the model to keep a `.omo/state.md`.

### Fixed

- **Every chat maintained a state file instead of doing its work.** The pressure notes at 70%, 85% and 93% told the model to write findings to `.omo/state.md`, the resume prompt asked it to read that file, and the compaction note pasted its contents back in. On a task with a written TZ it spent turns updating that file and closing "steps" instead of changing code. Those instructions and reads are gone; the notes now ask for paths, decisions and the next step to stay in the conversation, which is what the summary carries.
- `goal.md` is unchanged and remains the task contract.

## v1.6.8 – 2026-10-26

Thresholds prefer the provider's real prompt size over the estimate.

### Fixed

- **A live session compacted on a 493k estimate while its real prompt was 178k.** `used` was
  `estimate × cal`, and the estimator overcounts Cyrillic-heavy transcripts by more than a factor of
  two. When the outgoing request already contains an assistant message with provider usage, that
  reported size plus the tail after it is now used instead of the scaled estimate. The estimate
  remains the fallback when no sample is present.
- The `ctx` log line records `src: "real" | "est"`, so a decision can be checked against the number
  the provider actually reported.

### Tests

137 assertions (was 136): a real prompt sample wins over the scaled estimate.

## v1.6.7 – 2026-10-26

Calibration reads the transcript again.

### Fixed

- **Real token samples stopped being recorded, so every threshold used a stale multiplier.**
  `refreshCalibration` looked for `tokens` only on the top level of each transcript message. The
  runtime now returns them wrapped (`{info:{tokens}}`), so every sample was dropped without a word
  and `cal` stayed at its default 1.18. Measured live: a session compacted at an estimated 264 449
  tokens while the provider reported `input 1 284 + cache.read 212 480 = 213 764` — about 23% early,
  losing ~100k of usable history. Both shapes are read now.
- **A dropped sample is no longer silent.** If no message carries token counts, the plugin logs
  `calibrate-skip` with `reason: "no-tokens"` once per session, so the failure is visible instead of
  hiding behind a plausible-looking ratio.

### Tests

136 assertions (was 134): a wrapped `{info:{tokens}}` message is still sampled, and an unreadable
sample is logged rather than swallowed.

## v1.6.6 – 2026-10-24

A launch line no longer becomes the goal.

### Fixed

- **"я запускаю chck4.cmd" was filed as a task.** The state-report tier recognised "у меня запущен"
  and "я запустил", but not the present tense, so a message reporting that the user had launched
  something replaced the audit that was already in progress. It is context now, filed under
  `## Additions`. The weak tier still yields to an imperative: "я запускаю chck4.cmd, он падает -
  почини" remains a task.

### Tests

134 assertions (was 132): a launch statement does not replace the goal, and a launch statement that
asks for work stays the goal.

## v1.6.5 – 2026-10-24

Taking a message back and rewriting it now replaces it.

### Fixed

- **A full rewrite no longer leaves the old wording beside it.** Editing a message in the TUI stages a
  revert and admits the new text as a fresh prompt, and the plugin saw only two messages of the same
  kind: an addition extended by a few words deduped itself, but a rewrite in different words was
  appended as a second addition. The hook now reads the transcript and checks whether the prompt it
  recorded last is still there. A reverted message is gone from it, so the entry that message produced
  is removed before the new one is filed. A second message sent without a revert is still in the
  transcript and is still appended.
- The same rule applies to the task: a reverted and rewritten task replaces the goal and its
  requirement entry instead of adding another slot.
- The check is capped at two seconds and fails towards the old behaviour: if the transcript cannot be
  read, nothing is removed.

### Tests

132 assertions (was 126): a reverted-and-rewritten addition replaces the old wording, a message still
in history is not treated as an edit, a reverted-and-rewritten task replaces the old goal, and the
revision is logged as `goal-revision`.

## v1.6.4 – 2026-10-24

An addition is labelled once, as context.

### Fixed

- **The newest addition is no longer repeated as a "last instruction".** A message flagged as
  context also becomes the session's last instruction, and `goal.md` wrote it under both headings.
  The second copy sat under a label that reads like a command, which is the confusion the addition
  tier exists to prevent. It is now written once, under `## Additions`, and the last-instruction
  field says `(none - the newest addition above is context, not an instruction)`. The post-compaction
  anchor already quoted it only once and still does.

### Tests

126 assertions (was 123): the newest addition is absent from the last-instruction section, the file
says it is context and not an instruction, and the anchor quotes it exactly once.

## v1.6.3 – 2026-10-24

Context the user asked to keep in mind now survives a long session.

### Fixed

- **Additions are no longer capped at four.** The requirement list keeps four slots, which is right
  for a summary, but the additions were written through the same function: a fifth informational
  message silently pushed the oldest one out. A five-scenario probe (anchor, compaction note,
  `goal.md`, cap, ordering) showed the loss. Additions now have their own window of twelve, and when
  the anchor or the note can only quote the last two they name how many earlier ones are on disk.
- **An addition that arrives before the task is promoted once the task exists.** It becomes the goal
  because it is the only intent on record, but the first real task left it sitting in
  `## Requirements`, where it read as a second demand and the post-compaction summary would carry it
  as one. On the first real task such a goal moves to `## Additions`, leaves the requirement list,
  and the move is logged as `goal-addition` with `reason: "promoted-from-goal"`.

### Tests

123 assertions (was 119): six additions are all kept with the oldest intact, a pre-task addition is
promoted out of the goal and out of the requirements, and the promotion is logged.

## v1.6.2 – 2026-10-24

One goal, and a rewrite that replaces instead of piling up.

### Fixed

- **An informational message no longer overwrites the task.** Live evidence: a session where the
  user asked "проверь на других адресах, что мы НЕ ТЕРЯЕМ токены" and then added "у меня поиск
  запущен, просто чтобы ты знал, ошибки по прокси могут быть". `goal.md` recorded the *addition* as
  the goal, so the post-compaction anchor would have told the model to continue "the search is
  running" instead of the audit. The addition now goes to `## Additions (context to take into
  account, NOT tasks)` and the anchor quotes it as context that must not replace the goal.
- **A reworded requirement replaces the old one.** The same `goal.md` held one message three times
  because every extension was appended as a new requirement, leaving one real slot for the actual
  task. An extension (prefix, or containment of at least half the length) now replaces the previous
  entry and the longer version wins. The same dedupe applies to the `asks` carried in the
  compaction note.
- **The classifier cannot swallow real work.** A bare state report is not enough on its own: a
  message that mentions a running process *and* asks for something ("у меня запущен старый чекер и
  он падает на BNB - почини") stays a task. Only a phrase that describes itself as information
  ("просто чтобы ты знал", "к сведению") is trusted unconditionally.
- **The compaction note no longer restates an addition as a requirement.** `facts.asks` skipped
  informational messages; otherwise the note carried the addition twice, once as "context, NOT
  tasks" and once as "these ARE the requirements".

### Tests

119 assertions (was 103): an addition does not replace the goal, it lands in its own section, the
anchor carries it as context, a state report that asks for work stays the goal, the note does not
restate an addition as a requirement, an extension does not consume a slot, the longest version
wins, a genuinely new requirement is appended, a different ask that merely mentions an older one is
not merged into it, and an addition with no task on record still becomes the goal.

## v1.6.1 – 2026-10-23

The two things that made the model look dumber in long chats.

### Fixed

- **The pressure notes were suppressing quality.** At 70% they said "Keep replies short, avoid
  re-reading large files" and at 85% "Finish the current step ... Do not re-read large files". That
  is a direct instruction to stop verifying - and it was attached to every request above the
  threshold. Rewritten: work at full quality, do not shorten answers, do not skip steps, prefer
  targeted reads (grep, offset/limit) over whole files, and write concrete findings to
  `.omo/state.md`.
- **The compaction note now carries the specifics a summary used to lose.** It mines the transcript
  for the user's own words (up to four messages, verbatim), file paths with line ranges taken from
  ranged reads, the exact commands, and the error lines, then tells the summariser: keep every path,
  line number, symbol/function/table name, command and outcome, error message, decision with its
  reason, open TODO and the next step, and **do not paraphrase the user's requirements**.
- **`goal.md` keeps the requirements too.** Every substantive user message is appended (last four,
  verbatim) under `## Requirements`, so even a summary that drops them leaves the file intact.

### Tests

103 assertions (was 98): the note carries the user's own words, a ranged read as `file:from-to`,
commands verbatim, the anti-paraphrase instruction, and the noise-free wording checks.

### Live verification

Run on OpenCode 2.1.3 against the free gateway: two compactions completed in the same session
(summaries of 5 567 and 6 633 chars) with no `compact-backoff` between them, zero `emergency-trim`
lines across 250k tokens of context, and pruning at 1 499-3 099 chars per request - tool output
only, history untouched.

## v1.6.0 – 2026-10-23

Compaction that cannot succeed must not be retried forever, and the session must survive without it.

### Fixed

- **A failed compaction now buys silence instead of another attempt.** The summary request is the
  longest request in a session, so it is the one the provider truncates (`stream ended without
  finish_reason`). The old code counted the cooldown from the *request*, so it had already expired
  when the failure arrived - the next user message immediately asked for compaction again. On
  22 October that produced five compaction attempts in 23 minutes, none of which finished
  (`ses_e9e67afd...`). The cooldown is now measured from the failure and doubles per consecutive
  failure: 3 min → 6 → 12 → 24 → 30 max.
- **Emergency mode after two failures.** The plugin stops depending on compaction: above
  `emergencyRatio` (default `0.5`) every outgoing request has its old tool output cut to 600/200
  chars and its old assistant text/reasoning cut to 600 chars, while the last 6 messages stay
  byte-identical. A handoff note carries the goal and `.omo/state.md`, so the trimmed-away turns are
  not needed. No model call is involved, so there is nothing for the provider to truncate.
- **The session no longer stops at `interrupted`.** In `chkr2: почему нет ответа по Solana` the
  compaction died at 03:49:08 after four truncated retries and the session went idle-interrupted
  with the context still at 0.851 - the next message would have started the same cycle. With the
  backoff plus the trim, the same message is answered instead.
- The auto-continue error handler referenced an `event` variable that does not exist in that scope;
  it now uses the session id.

### Tests

98 assertions (was 91). New: a failure raises the backoff and enables emergency mode; no compaction
request is issued while the backoff holds; old assistant text is cut; the handoff note carries the
task; the mode switches off after a successful compaction.

## v1.5.0 – 2026-10-23

After compaction the model continues by itself.

- **`.omo/goal.md`** - written on every substantive user message: the task verbatim plus the last
  nudge. When the summary loses the task, the file still has it.
- **auto-continue** - `session.compaction.ended` used to leave the session idle, waiting for a manual
  "continue". One short prompt is now sent 1.5 s later (idle session only, 60 s cooldown, max 3 per
  session): read `.omo/goal.md` and `.omo/state.md`, take the next unfinished step, do not summarise,
  do not stop to ask.

## v1.4.0 – 2026-10-23

The post-compaction drift, fixed at its source.

### Fixed

- **The anchor quoted the last message, not the task.** After compaction the plugin injected
  "your current task, verbatim: ..." using `lastPrompt`. If the user's last message was
  **"продолжай"**, the model was told its task was the word "продолжай" - the summary had already
  dropped everything else, so it had nothing to continue and invented work. The plugin now keeps a
  separate `goal`: the last *substantive* user message. A nudge (`продолжай`, `дальше`, `continue`,
  `go on`, ...) is stored as `lastInstruction` and never replaces the goal.
- **The anchor now states which one wins.** "The user's task, verbatim: ... Their last instruction
  was only "продолжай" - that means carry on with the task above. ... If the summary disagrees with
  the task above, the task above wins." A compaction summary that describes the nudge can no longer
  redefine the goal.
- **The anchor repeats for one more request.** It used to be injected exactly once; if the first
  post-compaction turn was spent on a tool call that failed, the guidance was gone. It is now sent
  on the first two requests and then stops.
- `goal` is also used by the compaction note, the resume prompt and the checkpoint file, so all
  three quote the real task.

### Tests

86 assertions (was 82). New: the anchor survives a "продолжай" and names the nudge as a nudge; a
genuinely new task replaces the goal; the anchor repeats once and then stops.

## v1.3.5 – 2026-10-23

Tuning, based on the live log.

### Changed

- **A transport failure is retried seven times, not five.** The free gateway routinely dies two to
  four times in a row and then answers: the 2026-10-23 session recovered on the 4th attempt, and the
  old cap of five left almost no headroom. Six attempts are normal, the seventh means the gateway is
  down or the request is too long to survive - at that point the failure path (resume/compaction)
  takes over instead of hiding it behind more retries.
- **`maxTransportFails` is now an option** (default `7`), and it is stamped into the `setup` log
  line, so the limit is visible without reading the source.

### Tests

82 assertions (was 81). The sixth failure must still retry, the seventh must give up.

## v1.3.4 – 2026-10-23

Found in the live message store, not in a test.

### Fixed

- **A truncated stream was not retried.** The free gateway sometimes ends an SSE response after
  `data: {...}` deltas **without the final chunk that carries `finish_reason`**, usually on long
  reasoning streams (`variant: "max"`). OpenCode surfaces it as
  `provider.invalid-output: OpenAI Chat stream ended without finish_reason` (or
  `Invalid ... stream event` when a chunk is cut mid-frame). It arrives as HTTP 200 with no status,
  so the retry hook saw nothing transient and the step failed with no retry at all. Both messages
  are now classified as transport failures: dense retry (`1200 ms × attempt`, capped at 8 s), a
  forced prune on the second failure, and the usual 5-failure cap before the resume path takes over.
- Same class, same fix: `unexpected end of stream`, `incomplete stream/response`.

### Tests

81 assertions (was 78). The three new ones fail on v1.3.3: the truncated stream is not retried, the
cut stream frame is not retried, and the second failure never arms the forced prune.

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
