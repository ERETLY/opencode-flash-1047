import fs from 'node:fs'
import path from 'node:path'

// Token estimate. ASCII averages ~3.6 chars/token on this endpoint, but wide text (Cyrillic,
// CJK, emoji) costs about one token per two characters. A single chars/3.6 divisor undercounts a
// Russian prompt by ~45%, which is exactly how a request slips past the window before the first
// real usage sample arrives. Calibration (`cal`) removes the remaining bias.
const ASCII_PER_TOKEN = 3.6
const WIDE_PER_TOKEN = 2.0
const PLUGIN_ID = 'omni-resilience'
// Stamped into every `setup` log line, so "is the version I installed actually the version that
// is running?" is answerable from the log instead of from the file hash.
const VERSION = '1.6.9'

// Errors that neither a retry nor a resume prompt can fix: a wrong credential, a missing route or a
// model id the gateway does not know. The old pattern `model.unavailable` matched exactly one
// character between the words, so the real gateway message "Model is unavailable" slipped past it.
const FATAL_RE = /auth|permission|forbidden|unauthori[sz]ed|401|403|no-route|model.{0,6}unavailable|model_not_found/i

// A 4xx that names the model as unavailable/unknown is a config error (wrong model id), not a
// transient outage: retrying it only burns the whole backoff budget before failing anyway.
const MODEL_CONFIG_RE = /model.{0,6}(unavailable|not.?found)|unknown model|model_not_found/i

const DEFAULTS = {
  // hard scope: the plugin only ever manages this one entry
  providerID: 'flash1047',
  modelID: 'deepseek-v4.1-flash-free',
  contextLimit: 310000,
  warn: 0.7,
  // quality default: compact at 85% so a one-shot estimator error cannot push the request
  // past the measured 319_123-token ceiling, and so sessions spend less time in the
  // 270k-310k zone where attention is weakest
  compact: 0.85,
  hard: 0.93,
  every: 20,
  cooldownMs: 180000,
  // When compaction keeps failing (the provider truncates the summarisation stream) the session
  // must survive without it. Below this ratio the emergency trim leaves the request alone; above
  // it, old tool output and old assistant text are cut so the prompt fits the provider ceiling.
  emergencyRatio: 0.5,
  stallMs: 900000,
  maxResumes: 4,
  resumeCooldownMs: 120000,
  // A transport failure is a dead stream, not a dead endpoint: retrying is cheap and usually
  // works. Six attempts cover the free gateway's normal behaviour (it often dies 2-4 times in a
  // row and then answers); by the seventh the gateway is not blipping, it is down or the request
  // is too long to survive, so let the failure path surface it instead of hiding it.
  maxTransportFails: 7,
  keepRecent: 12,
  // prune only once the session is genuinely large; eliding tool output at 55% threw away
  // file contents while there was still 140k tokens of room
  pruneSoft: 0.7,
  // must match compaction.keep.tokens in opencode.jsonc: the runtime cannot summarise
  // anything inside this window, so asking below it only produces "Nothing to compact yet"
  keep: 15000,
  // a compaction event that never arrives must not leave the flag set forever
  compactingTtlMs: 120000,
  // measured free-tier ceiling: 319_123 tokens accepted, 325_760 rejected (400 context_length_exceeded)
  ceiling: 318000,
  // headroom kept free for the reply and for estimate error
  margin: 4000,
}

// Long-session rules live in ~/.config/opencode/instructions/long-session.md, which OpenCode
// already loads into the system prompt for every session. The plugin used to inject a second
// copy per session; that duplicated the text and drifted from the file, so it is gone.

// setup() runs once per location; several instances may load for the same root,
// so state, the event subscription and the stall timer are shared per root.
const GLOBAL: any = globalThis as any
GLOBAL.__omniResilience ||= { byRoot: new Map<string, any>() }

const textTokens = (s: string): number => {
  let ascii = 0
  let wide = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++
    else wide++
  }
  return ascii / ASCII_PER_TOKEN + wide / WIDE_PER_TOKEN
}

const estimate = (v: any): number => {
  let tokens = 0
  const walk = (x: any) => {
    if (!x) return
    if (typeof x === 'string') {
      tokens += textTokens(x)
      return
    }
    if (Array.isArray(x)) {
      for (const i of x) walk(i)
      return
    }
    if (typeof x === 'object') {
      for (const k of Object.keys(x)) {
        if (k === 'metadata') continue
        walk(x[k])
      }
    }
  }
  walk(v)
  return Math.round(tokens)
}

const headTail = (s: string, head: number, tail: number) => {
  if (s.length <= head + tail + 400) return s
  const cut = s.length - head - tail
  return (
    s.slice(0, head) +
    `\n\n[omni-resilience] ${cut} chars were removed from the middle of this tool output by the client ` +
    `to protect the context window. You cannot see them - do not guess or reconstruct their contents. ` +
    `Re-run the tool with grep/offset/limit if you need that part again.\n\n` +
    s.slice(-tail)
  )
}

// The provider reports the exact prompt size on every assistant message. When the outgoing request
// already contains such a message, that number plus the tail after it is a measurement, not an
// estimate - and the estimate can be far off on Cyrillic-heavy text where calibration cannot help
// if it never receives a sample.
const lastPromptUsage = (messages: any[]): { real: number; index: number } | null => {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: any = messages[i]
    const t = m?.tokens ?? m?.info?.tokens ?? m?.metadata?.tokens ?? m?.data?.tokens
    if (t && typeof t.input === 'number') {
      const real = Number(t.input || 0) + Number(t.cache?.read || 0) + Number(t.cache?.write || 0)
      if (real > 1000) return { real, index: i }
    }
  }
  return null
}

// The pressure note we append to an outgoing request. If the runtime keeps that array and hands it
// back on the next step, appending a fresh copy every request would grow the very context this
// plugin exists to protect. Strip, then append exactly one. Only the pressure note matches: the
// compaction note and the post-compaction anchor share the prefix but are different messages.
const isPressureNote = (m: any): boolean => {
  if (!m || m.role !== 'user' || !Array.isArray(m.content) || m.content.length !== 1) return false
  const p = m.content[0]
  if (!p || p.type !== 'text' || typeof p.text !== 'string') return false
  return p.text.startsWith('[omni-resilience]') && /Automatic note, not from the user\./.test(p.text)
}

const stripPressureNotes = (messages: any[]): number => {
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPressureNote(messages[i])) {
      messages.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

// A nudge is not a task. After compaction the anchor quotes the user's goal; if the last thing
// they typed was "продолжай", quoting that would leave the model with nothing to continue - which
// is exactly the "it forgot what it was doing" failure. Only a whole-string match counts, so
// "делай рефакторинг модуля" stays a real task.
const CONTINUE_RE =
  /^(?:(?:ok|okay|да|ну)[,.! ]*)?(?:продолжай|продолжи|продолжаем|продолжить|дальше|давай дальше|погнали|жми|делай дальше|го|continue|go on|keep going|resume|carry on|next|proceed)(?:[,.! ]*(?:дальше|please|пж|плиз))?[.!? ]*$/i
const isContinuation = (t: string): boolean => {
  const s = String(t || '').trim()
  if (!s) return true
  if (s.length > 80) return false
  return CONTINUE_RE.test(s)
}

// An addition is not a task. "у меня поиск запущен, просто чтобы ты знал" is context the model has
// to hold, not the goal - otherwise the post-compaction anchor would tell it to continue "the
// search is running" instead of the real task.
//
// Two tiers, deliberately. A phrase that describes itself as information ("просто чтобы ты знал",
// "к сведению") is trusted on its own. A bare state report ("у меня запущен...") is NOT enough:
// "у меня запущен старый чекер и он падает на BNB - почини" is a task that happens to mention a
// running process, and misfiling it would leave the goal stale and silent. So the weak tier only
// counts when no imperative is present.
const ADDITION_STRONG_RE =
  /(?:чтобы ты (?:знал|понимал|учитывал|имел в виду)|просто (?:знай|имей в виду)|имей в виду|для информации|к сведению|на заметку|не как задание)/i
const ADDITION_WEAK_RE =
  /(?:у меня (?:сейчас )?(?:запущ|идёт|идет|работает)|я запустил|я запускаю|я гоняю|мой поиск)/i
const TASK_VERB_RE =
  /(?:почини|исправь|сделай|добавь|убери|удали|напиши|перепиши|замени|запусти|проверь|перепроверь|протестируй|найди|посмотри|разберись|обнови|построй|собери|отрефакторь|оптимизируй|настрой|сравни|посчитай|покажи)/i
const isAddition = (t: string): boolean => {
  const s = String(t || '').trim()
  if (!s || s.length > 700) return false
  if (ADDITION_STRONG_RE.test(s)) return true
  return ADDITION_WEAK_RE.test(s) && !TASK_VERB_RE.test(s)
}

// Two messages sharing a leading run are the same requirement written twice - the user extended
// it or retyped it with more detail. Keeping both eats the limited slots in goal.md with one
// demand (observed live: one reworded message took three of the four slots). Containment covers an
// appended tail. Deliberately NOT word-overlap based: merging on shared vocabulary would silently
// fuse two different requirements into one, and a duplicate costs a slot while a merged demand
// costs the actual task.
const sameAsk = (a: string, b: string): boolean => {
  const x = String(a || '').trim().slice(0, 200)
  const y = String(b || '').trim().slice(0, 200)
  if (!x || !y) return false
  if (x === y) return true
  const short = x.length < y.length ? x : y
  const long = x.length < y.length ? y : x
  if (short.length < 24) return false
  if (long.startsWith(short)) return true
  // Containment without a size guard would fuse two different demands whenever the older one
  // happens to be quoted inside a longer new one. Half the length is the cut-off: an extension
  // keeps most of the original, a different ask that merely mentions it does not.
  return long.includes(short) && short.length / long.length >= 0.5
}

// Append without duplicating a requirement the user already wrote. The longer version wins,
// because the extension is usually where the detail lives.
//
// The cap differs by list on purpose. Requirements are four slots because a summary cannot carry
// more and older asks are superseded anyway. Additions are standing context the user explicitly
// asked to be kept in mind, so dropping them silently is a loss - they get a much wider window.
const pushAsk = (list: any, t: string, cap = 4): string[] => {
  const out: string[] = Array.isArray(list) ? list.slice() : []
  for (let i = out.length - 1; i >= 0; i--) {
    if (sameAsk(out[i], t)) {
      out[i] = t.length > out[i].length ? t : out[i]
      return out.slice(-cap)
    }
  }
  out.push(t)
  return out.slice(-cap)
}
const ADDITIONS_CAP = 12

// A message can be taken back: revert it in the TUI, rewrite it, send again. OpenCode admits the
// edited text as a fresh prompt, so without this the first version stays in goal.md and the rewrite
// lands beside it as if it were a second demand. Two prompts of the same kind, the second arriving
// while the first is still unanswered and inside the window, are one intent written twice.
const REVISION_WINDOW_MS = 10 * 60_000

// Stored entries are truncated, so a long addition cannot be compared with ===. Twenty-four shared
// leading characters are specific enough to say "this is the entry that message produced".
const sameEntry = (a: string, b: string): boolean => {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return false
  if (x === y) return true
  const n = Math.min(x.length, y.length, 200)
  return n >= 24 && x.slice(0, n) === y.slice(0, n)
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    const root = ctx.location?.directory || process.cwd()
    const opts = ctx.options ?? {}
    const CFG = {
      limit: Number(opts.contextLimit ?? DEFAULTS.contextLimit),
      // Compaction is owned by OpenCode by default: it has the provider's real token accounting,
      // while this plugin only estimates. Two estimators disagreeing caused repeated early
      // compactions (live: 493k estimated vs 178k reported, then 350k vs ~50k). The plugin still
      // prunes, warns, retries and re-anchors; it just does not summarise on a guess.
      ownCompact: Boolean(opts.ownCompact),
      warn: Number(opts.warn ?? DEFAULTS.warn),
      compact: Number(opts.compact ?? DEFAULTS.compact),
      hard: Number(opts.hard ?? DEFAULTS.hard),
      every: Number(opts.every ?? DEFAULTS.every),
      cooldownMs: Number(opts.cooldownMs ?? DEFAULTS.cooldownMs),
      emergencyRatio: Number(opts.emergencyRatio ?? DEFAULTS.emergencyRatio),
      stallMs: Number(opts.stallMs ?? DEFAULTS.stallMs),
      maxResumes: Number(opts.maxResumes ?? DEFAULTS.maxResumes),
      resumeCooldownMs: Number(opts.resumeCooldownMs ?? DEFAULTS.resumeCooldownMs),
      maxTransportFails: Number(opts.maxTransportFails ?? DEFAULTS.maxTransportFails),
      keepRecent: Number(opts.keepRecent ?? DEFAULTS.keepRecent),
      pruneSoft: Number(opts.pruneSoft ?? DEFAULTS.pruneSoft),
      keep: Number(opts.keep ?? DEFAULTS.keep),
      compactingTtlMs: Number(opts.compactingTtlMs ?? DEFAULTS.compactingTtlMs),
      ceiling: Number(opts.ceiling ?? DEFAULTS.ceiling),
      margin: Number(opts.margin ?? DEFAULTS.margin),
      // 'tail' (default): context-pressure notes are appended as the last message of the outgoing
      // request, so the cached prefix (system prompt + history) is never touched.
      // 'system': the same note goes into the system prompt instead (breaks prefix caching).
      warnMode: String(opts.warnMode ?? 'tail') === 'system' ? 'system' : 'tail',
    }

    // Hard scope. The plugin exists for exactly one entry: flash 1047 / deepseek-v4.1-flash-free.
    // It never switches models and it never manages any other model's session - if the guarded
    // model is not the one in use, every behaviour below is a no-op.
    const ONLY = String(opts.onlyModelID ?? DEFAULTS.modelID).trim()
    const ONLY_P = String(opts.onlyProviderID ?? DEFAULTS.providerID).trim()
    const GUARDED = ONLY_P && ONLY ? `${ONLY_P}/${ONLY}` : 'unscoped'
    const modelKey = (s: any) => (s?.providerID && s?.modelID ? `${s.providerID}/${s.modelID}` : '')
    const ours = (s: any) => Boolean(s) && (!ONLY || s.modelID === ONLY) && (!ONLY_P || s.providerID === ONLY_P)

    const reg: Map<string, any> = GLOBAL.__omniResilience.byRoot
    const regKey = `${root}::${PLUGIN_ID}`
    if (!reg.has(regKey)) {
      reg.set(regKey, { states: new Map<string, any>(), timerStarted: false, subscribed: false, hooksRegistered: false })
    }
    const shared = reg.get(regKey)
    const state: Map<string, any> = shared.states

    const logs = path.join(root, '.omo', 'logs')
    const ckptDir = path.join(root, '.omo', 'checkpoints')
    const log = (o: any) => {
      try {
        fs.mkdirSync(logs, { recursive: true })
        fs.appendFileSync(path.join(logs, 'resilience.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n')
      } catch {}
    }

    // ---- no model failover ------------------------------------------------
    // This plugin never changes the session model. Switching silently traded the model the user
    // picked for whatever happened to answer, which cost quality and context shape far more often
    // than it saved a turn. A dead endpoint is now handled by retry/backoff and, if it stays dead,
    // by the normal failure path (resume prompt), so the user always knows what happened.

    const get = (id: string) => {
      if (!state.has(id)) {
        state.set(id, {
          marks: {},
          toolCount: 0,
          lastTool: 'none',
          lastPrompt: '',
          lastCompactAt: 0,
          compactFails: 0,
          emergency: false,
          compacting: false,
          estimatedTokens: 0,
          contextLimit: CFG.limit,
          pending: new Set<string>(),
          lastEventAt: Date.now(),
          lastErrorAt: 0,
          lastError: '',
          resumes: 0,
          lastResumeAt: 0,
          busy: false,
          stalled: false,
          inflight: false,
          transportFails: 0,
          forcePrune: false,
          prunedChars: 0,
          modelLookup: 0,
          recent: [],
          anchor: null,
          anchorLeft: 0,
          goal: '',
          additions: [],
          lastInstruction: '',
          cal: 1.18, // measured default; calibration replaces it with real samples
          calN: 0,
          prevEst: 0,
          lastReal: 0,
        })
      }
      return state.get(id)
    }

    // resolve the session model when an event arrives before the first context hook
    const ensureModel = async (sessionID: string, s: any) => {
      if (!ONLY && !ONLY_P) return
      if (s.modelID && (!ONLY_P || s.providerID)) return
      if (s.modelLookup >= 3) return
      s.modelLookup += 1
      try {
        const info: any = await ctx.session.get({ sessionID })
        const m = info?.model ?? info?.data?.model
        if (m?.id) {
          s.modelID = m.id
          s.providerID = m.providerID
        }
      } catch {}
    }

    // Scope check for hooks that can fire before the first context request (prompt, retry).
    // Without this the plugin silently ignored the very first user prompt of a session, which is
    // exactly the text resume/compaction need in order to keep the task alive.
    const manage = async (sessionID: string, s: any) => {
      if (!s.modelID || !s.providerID) await ensureModel(sessionID, s)
      return ours(s)
    }

    // The previous prompt is still in the transcript unless the user reverted it. OpenCode removes
    // the reverted message before admitting the rewrite, so "the text I saw last time is gone" is
    // the signal that this is an edit, not a second message. A read failure answers null and the
    // caller keeps the old behaviour: append, never delete on a guess.
    const priorStillInHistory = async (sessionID: string, prev: string): Promise<boolean | null> => {
      try {
        const res: any = await Promise.race([
          ctx.session.context({ sessionID }),
          new Promise((r) => setTimeout(() => r(null), 2000)),
        ])
        if (!res) return null
        const msgs = res?.messages ?? res?.data ?? res
        if (!Array.isArray(msgs)) return null
        for (const m of msgs) {
          if (String(m?.role || '') !== 'user') continue
          const c = m?.content ?? m?.parts ?? ''
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c.map((p: any) => (p?.type === 'text' ? String(p.text || '') : '')).join(' ')
                : ''
          if (sameEntry(text, prev)) return true
        }
        return false
      } catch {
        return null
      }
    }

    const writeCheckpoint = async (sessionID: string, reason: string) => {
      const s = get(sessionID)
      if (!ours(s)) return
      try {
        {
          try {
            const res: any = await ctx.session.context({ sessionID })
            const msgs = res?.messages ?? res?.data ?? res
            if (Array.isArray(msgs)) {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const parts = msgs[i]?.content || msgs[i]?.parts || []
                let found = ''
                for (let k = parts.length - 1; k >= 0; k--) {
                  const p = parts[k]
                  if (p?.type === 'tool' && (p.name || p.toolName)) {
                    found = p.name || p.toolName
                    break
                  }
                  if (p?.type === 'tool-call' && (p.toolName || p.name)) {
                    found = p.toolName || p.name
                    break
                  }
                }
                if (found) {
                  s.lastTool = found
                  break
                }
              }
            }
          } catch {}
        }
        fs.mkdirSync(ckptDir, { recursive: true })
        const payload = {
          sessionID,
          modelID: s.modelID || 'unknown',
          providerID: s.providerID || 'unknown',
          toolCallCount: s.toolCount,
          lastToolName: s.lastTool,
          lastUserPrompt: String(s.lastPrompt || '').slice(0, 4000),
          goal: String(s.goal || '').slice(0, 1200),
          estimatedTokens: s.estimatedTokens,
          contextLimit: s.contextLimit,
          prunedChars: s.prunedChars,
          resumes: s.resumes,
          reason,
          timestamp: new Date().toISOString(),
        }
        fs.writeFileSync(path.join(ckptDir, `${sessionID}.json`), JSON.stringify(payload, null, 2))
        log({ at: 'checkpoint', sessionID, reason, toolCount: s.toolCount, tokens: s.estimatedTokens })
      } catch (e: any) {
        log({ at: 'checkpoint-error', sessionID, error: String(e?.message || e) })
      }
    }

    // ---- real-token calibration ------------------------------------------------
    // The raw estimate cannot be trusted at the top of the window: tool schemas add a fixed
    // ~1.8k tokens that never appear in the messages, and chars/token moves with the content
    // (measured: 3.6 estimate vs 6.0 chars/token on repetitive text, and the reverse on dense
    // JSON). Every completed assistant message carries the provider's real usage, so learn the
    // ratio real/estimate and apply it to every threshold decision.
    const refreshCalibration = async (sessionID: string) => {
      const s = get(sessionID)
      if (!ours(s)) return
      const prev = Number(s.prevEst || 0)
      if (prev < 1500) return
      try {
        const res: any = await ctx.session.context({ sessionID })
        const msgs = res?.messages ?? res?.data ?? res
        if (!Array.isArray(msgs)) return
        let tk: any = null
        let msgKey = ''
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m: any = msgs[i]
          // The transcript has been returned both flat ({tokens}) and wrapped ({info:{tokens}})
          // across runtime versions. Reading only the flat shape made every sample vanish
          // silently, leaving `cal` at its default and compacting ~18% early.
          const t = m?.tokens ?? m?.info?.tokens ?? m?.metadata?.tokens ?? m?.data?.tokens
          if (t && typeof t.input === 'number') {
            tk = t
            msgKey = String(m?.id ?? m?.info?.id ?? m?.time?.completed ?? m?.time?.created ?? '')
            break
          }
        }
        if (!tk) {
          if (!s.calSkipLogged) {
            s.calSkipLogged = true
            log({ at: 'calibrate-skip', sessionID, reason: 'no-tokens', msgs: msgs.length })
          }
          return
        }
        // cached prompt tokens are reported separately from the non-cached `input`
        const real = Number(tk.input || 0) + Number(tk.cache?.read || 0) + Number(tk.cache?.write || 0)
        if (!Number.isFinite(real) || real < 1000) return
        const ratio = real / prev
        if (!(ratio > 0.3 && ratio < 3)) return

        // Several tool events (parallel tool calls, success + execution end) read the same last
        // assistant message. Count each completed step once: the message identity is part of the
        // key, otherwise two turns that produced identical numbers would merge into one sample and
        // the ratio would stop tracking the real size.
        const sig = `${msgKey || msgs.length}|${real}|${prev}`
        if (s.lastCalSig === sig) return
        s.lastCalSig = sig
        // EMA, but jump faster when the content mix changed sharply (ASCII -> Cyrillic, text ->
        // dense JSON), otherwise the stale weight keeps mis-predicting the next request.
        const jump = !s.calN || Math.abs(ratio - s.cal) / s.cal > 0.3
        const w = jump ? 0.65 : 0.4
        s.cal = s.calN ? Number((s.cal * (1 - w) + ratio * w).toFixed(4)) : Number(ratio.toFixed(4))
        s.cal = Math.min(2.5, Math.max(0.4, s.cal))
        s.calN = (s.calN || 0) + 1
        s.lastReal = real
        log({
          at: 'calibrate',
          sessionID,
          real,
          estimate: prev,
          cal: s.cal,
          n: s.calN,
          jump,
          reasoning: Number(tk.reasoning || 0),
          output: Number(tk.output || 0),
        })
      } catch {}
    }

    // actual runtime state according to the server, not our event bookkeeping
    const sessionState = async (sessionID: string) => {
      try {
        const info: any = await ctx.session.get({ sessionID })
        const raw = info?.status?.type ?? info?.status ?? info?.data?.status?.type ?? info?.data?.status
        const status = typeof raw === 'string' ? raw : ''
        const outcome = String(info?.outcome ?? info?.data?.outcome ?? '')
        const running = status ? /running|busy|retry|streaming/i.test(status) : !/succeeded|failed|interrupted/i.test(outcome)
        return { running, status, outcome }
      } catch {
        return { running: false, status: '', outcome: '' }
      }
    }

    // true only when the last user turn never reached an idle/completed state
    const needsContinuation = async (sessionID: string) => {
      try {
        const res: any = await ctx.session.context({ sessionID })
        const msgs = res?.messages ?? res?.data ?? res
        if (!Array.isArray(msgs) || !msgs.length) return false
        const last = msgs[msgs.length - 1]
        const t = String(last?.type || last?.role || '')
        // 'idle' means the platform closed the turn (succeeded, failed or interrupted on purpose)
        if (t === 'idle') return false
        if (t === 'user' || t === 'tool') return true
        if (t === 'assistant') {
          const parts = Array.isArray(last.content) ? last.content : []
          const hasTool = parts.some((p: any) => p && (p.type === 'tool-call' || p.type === 'tool' || p.type === 'tool-invocation'))
          const hasText = parts.some((p: any) => p && p.type === 'text' && String(p.text || '').trim().length > 0)
          // unfinished tool call, or an assistant message that produced nothing at all
          return hasTool || !hasText
        }
        return false
      } catch {
        return false
      }
    }

    // did the model already produce visible prose after the last user message?
    const answerSinceUser = async (sessionID: string) => {
      try {
        const res: any = await ctx.session.context({ sessionID })
        const msgs = res?.messages ?? res?.data ?? res
        if (!Array.isArray(msgs)) return false
        let at = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (String(msgs[i]?.type || msgs[i]?.role || '') === 'user') {
            at = i
            break
          }
        }
        if (at < 0) return false
        for (let i = at + 1; i < msgs.length; i++) {
          const m = msgs[i]
          if (String(m?.type || m?.role || '') !== 'assistant') continue
          const parts = Array.isArray(m.content) ? m.content : []
          if (parts.some((p: any) => p && p.type === 'text' && String(p.text || '').trim().length > 0)) return true
        }
        return false
      } catch {
        return false
      }
    }

    const resume = async (sessionID: string, reason: string, force = false) => {
      const s = get(sessionID)
      if (!(await manage(sessionID, s))) return
      if (s.resumes >= CFG.maxResumes) {
        log({ at: 'resume-capped', sessionID, resumes: s.resumes })
        return
      }
      if (Date.now() - s.lastResumeAt < CFG.resumeCooldownMs) return
      const state = await sessionState(sessionID)
      if (state.running && !force) {
        log({ at: 'resume-skip', sessionID, why: 'still-running', reason })
        return
      }
      if (force) {
        // our own stall interrupt produces an 'interrupted' idle message: that is not an answer
        if (await answerSinceUser(sessionID)) {
          log({ at: 'resume-skip', sessionID, why: 'answer-present', reason, outcome: state.outcome })
          s.inflight = false
          s.stalled = false
          return
        }
      } else if (!(await needsContinuation(sessionID))) {
        log({ at: 'resume-skip', sessionID, why: 'no-open-turn', reason, outcome: state.outcome })
        s.inflight = false
        s.stalled = false
        return
      }
      s.resumes += 1
      s.lastResumeAt = Date.now()
      s.stalled = false
      log({ at: 'resume', sessionID, reason, attempt: s.resumes })
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const task = String(s.goal || s.lastPrompt || '').trim().slice(0, 500)
        await ctx.session.prompt({
          sessionID,
          text:
            `The previous turn stopped unexpectedly (${reason}). Continue EXACTLY where you left off. ` +
            (task ? `Your task, verbatim from the user: "${task}". ` : '') +
            `Do not restart the task and do not repeat finished work. Read .omo/state.md and the latest checkpoint if they exist, ` +
            `then perform the next unfinished step. If a tool call failed, retry it or pick an alternative.`,
        })
        log({ at: 'resume-sent', sessionID, attempt: s.resumes })
      } catch (e: any) {
        log({ at: 'resume-error', sessionID, error: String(e?.message || e) })
      }
    }

    // The runtime can load this plugin twice in one process, back to back: once from the
    // plugins/ directory scan and once from the `plugins` config entry that carries the options.
    // Hooks are not de-duplicated by the runtime, so a second registration pushes every request
    // through the same logic twice: retry counters double, log lines double, notes get appended
    // twice. The window is deliberately short (a few seconds) because a genuine double load is
    // simultaneous: a later load may belong to another session that needs its own registration,
    // and skipping that would silently disable the plugin for that session.
    if (shared.hooksRegistered && Date.now() - Number(shared.hooksAt || 0) < 3000) {
      log({
        at: 'setup-duplicate',
        plugin: VERSION,
        pid: typeof process !== 'undefined' ? process.pid : 0,
        root,
        note: 'a simultaneous second load for this root; hooks stay registered once',
      })
      return
    }
    shared.hooksRegistered = true
    shared.hooksAt = Date.now()

    await ctx.session.hook('prompt', async (event: any) => {
      const s = get(event.sessionID)
      if (!(await manage(event.sessionID, s))) return
      const text = event.prompt?.text || ''
      // our own messages are not user intent: a resume nudge and the auto-continue prompt must not
      // overwrite the goal or reset the turn budget
      const internal = text.startsWith('The previous turn stopped unexpectedly') || text.startsWith('[omni-resilience]')
      if (!internal) {
        const t = String(text || '').trim()
        s.lastPrompt = text
        // A rewrite of the previous message: same kind, still unanswered, inside the window. The
        // entry the first version produced is removed so the file does not keep a stale copy.
        const kind = t && !isContinuation(t) ? (isAddition(t) ? 'addition' : 'task') : ''
        let revised = false
        if (
          kind &&
          kind === s.lastPromptKind &&
          s.lastPromptAt &&
          t !== s.lastPromptText &&
          Date.now() - s.lastPromptAt <= REVISION_WINDOW_MS
        ) {
          const priorInHistory = await priorStillInHistory(event.sessionID, s.lastPromptText)
          if (priorInHistory === false) {
            const list =
              kind === 'addition'
                ? Array.isArray(s.additions)
                  ? s.additions.slice()
                  : []
                : Array.isArray(s.asks)
                  ? s.asks.slice()
                  : []
            if (list.length && sameEntry(list[list.length - 1], s.lastPromptText)) {
              list.pop()
              revised = true
              if (kind === 'addition') s.additions = list
              else s.asks = list
            }
          }
        }
        if (revised) log({ at: 'goal-revision', sessionID: event.sessionID, kind, chars: t.length })
        if (t && isContinuation(t)) {
          // a nudge: keep the goal, remember what was asked on top of it
          s.lastInstruction = t.slice(0, 200)
        } else if (t && isAddition(t) && String(s.goal || '').trim()) {
          // Context, not a task. "у меня поиск запущен, просто чтобы ты знал" must be held in mind
          // without displacing the goal: the post-compaction anchor quotes s.goal, and pointing it
          // at an informational aside is how the model ends up continuing the wrong work.
          s.lastInstruction = t.slice(0, 200)
          s.additions = pushAsk(Array.isArray(s.additions) ? s.additions : [], t.slice(0, 600), ADDITIONS_CAP)
          log({ at: 'goal-addition', sessionID: event.sessionID, chars: t.length, additions: s.additions.length })
        } else if (t) {
          // An addition that arrived before any task had to be filed as the goal - it was the only
          // intent on record. Now that real work exists it belongs in the additions, not in the
          // requirement list where it would pose as the task.
          if (isAddition(String(s.goal || '')) && String(s.goal || '').trim()) {
            s.additions = pushAsk(Array.isArray(s.additions) ? s.additions : [], String(s.goal).slice(0, 600), ADDITIONS_CAP)
            s.asks = (Array.isArray(s.asks) ? s.asks : []).filter((a: string) => !sameAsk(a, String(s.goal)))
            log({ at: 'goal-addition', sessionID: event.sessionID, reason: 'promoted-from-goal', additions: s.additions.length })
          }
          s.goal = t.slice(0, 1200)
          s.goalAt = Date.now()
          s.lastInstruction = ''
          // Keep the user's own words, not a paraphrase: after compaction the summary is the only
          // history left, so the requirements live in goal.md as well. An extension of a previous
          // ask replaces it rather than consuming another slot.
          s.asks = pushAsk(Array.isArray(s.asks) ? s.asks : [], t.slice(0, 600))
        }
        if (kind) {
          s.lastPromptKind = kind
          s.lastPromptText = t
          s.lastPromptAt = Date.now()
        }
        // The goal is a file, not a phrase list. Whatever the task is, it is written down once and
        // the post-compaction anchor points at it; the summary can lose it, the file cannot.
        try {
          fs.mkdirSync(path.join(root, '.omo'), { recursive: true })
          // The newest addition is also the message that set lastInstruction. Writing it under a
          // second heading labelled "Last instruction" makes context read like a command, which is
          // exactly what the addition tier exists to prevent.
          const lastInstr = String(s.lastInstruction || '').trim()
          const lastIsAddition =
            !!lastInstr &&
            (Array.isArray(s.additions) ? s.additions : []).some((a: string) => sameAsk(a, lastInstr))
          fs.writeFileSync(
            path.join(root, '.omo', 'goal.md'),
            `# Goal\n\n${s.goal || '(not set yet)'}\n\n` +
              `## Requirements (the user's own words, oldest first)\n\n` +
              `${(Array.isArray(s.asks) && s.asks.length ? s.asks : []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n') || '(none yet)'}\n\n` +
              `## Additions (context to take into account, NOT tasks)\n\n` +
              `${(Array.isArray(s.additions) && s.additions.length ? s.additions : []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n') || '(none)'}\n\n` +
              `## Last instruction\n\n${lastInstr ? (lastIsAddition ? '(none - the newest addition above is context, not an instruction)' : lastInstr) : '(none)'}\n\n---\n` +
              `_Updated ${new Date().toISOString()} by omni-resilience (session ${event.sessionID}). ` +
              `This file is the task contract after compaction - edit it freely._\n`,
          )
        } catch {}
        s.resumes = 0
        s.lastResumeAt = 0
        s.transportFails = 0
        s.forcePrune = false
        s.compactEmpty = 0
      }
      log({ at: 'prompt', sessionID: event.sessionID, chars: text.length, model: modelKey(s) })
    })

    await ctx.session.hook('context', (event: any) => {
      const s = get(event.sessionID)
      s.modelID = event.model?.id
      s.providerID = event.model?.providerID

      // ---- scope guard: every resilience behaviour below is for the guarded model only ----
      if (!ours(s)) return

      s.contextLimit = CFG.limit

      // ---- post-compaction re-anchor (the anti-drift part) -------------------
      // Compaction replaces the live conversation with a summary. Without a re-anchor the model
      // tends to drift into invented work right after it, so the first request after a
      // successful compaction gets the user's task quoted back, once.
      if (s.anchor) {
        const goal = String(s.goal || s.lastPrompt || '').trim().slice(0, 800)
        const nudge = String(s.lastInstruction || '').trim().slice(0, 200)
        const allAdds: string[] = (Array.isArray(s.additions) ? s.additions : [])
          .map((a: string) => String(a || '').trim())
          .filter(Boolean)
        const adds = allAdds.slice(-2)
        // The last instruction and the latest addition are usually the same message. Quoting it
        // twice costs tokens and reads like two separate demands.
        const nudgeIsAddition = !!nudge && adds.some((a) => sameAsk(a, nudge))
        const text =
          `[omni-resilience] The conversation was just compacted; earlier turns exist only as a summary. ` +
          (goal ? `The user's task, verbatim: "${goal}". ` : `Your task is in the summary. `) +
          (adds.length
            ? `Context they added on top of the task (hold in mind, NOT tasks - do not swap the goal for it): ${adds
                .map((a) => `"${a}"`)
                .join(' | ')}. ` +
              (allAdds.length > adds.length
                ? `(${allAdds.length - adds.length} earlier addition${allAdds.length - adds.length === 1 ? '' : 's'} are in .omo/goal.md under "Additions" - read them there.) `
                : '')
            : '') +
          (nudge && nudge !== goal && !nudgeIsAddition
            ? `Their last instruction was only "${nudge}" - that means carry on with the task above. `
            : '') +
          `Before anything else, read .omo/goal.md and .omo/state.md, then take the next unfinished step. ` +
          `Do not restart the task, do not ask the user to repeat anything, and do not invent new work. ` +
          `If the summary disagrees with the task above, the task above wins.`
        event.system.push({ type: 'text', text })
        s.anchorLeft = Number(s.anchorLeft || 1) - 1
        s.anchor = s.anchorLeft > 0 ? { at: Date.now(), reason: 'compaction', repeat: true } : null
        log({ at: 'anchor', sessionID: event.sessionID, reason: 'post-compaction', task: goal.slice(0, 80), left: Math.max(0, s.anchorLeft) })
      }

      // No protocol injection here: OpenCode already puts instructions/long-session.md into the
      // system prompt for every session (verified via the instruction blobs), so a second copy
      // only burned tokens and drifted from the file.

      // ---- calibrated size + output reservation ----------------------------
      // The raw estimate ignores tool schemas (~1.8k tokens measured) and chars/token varies with
      // the content, so every decision uses `estimate * cal`, where `cal` is learned from the real
      // `tokens.input + cache.read` of the last completed step. The reply reservation is then
      // clamped so that prompt + output can never cross the measured free-tier ceiling.
      // Remove a note a previous request left behind before anything is measured, so a persisted
      // note can neither inflate the estimate nor be joined by a second copy.
      let histLen = Array.isArray(event.messages) ? event.messages.length : 0
      if (Array.isArray(event.messages)) {
        const stripped = stripPressureNotes(event.messages)
        if (stripped) {
          histLen = event.messages.length
          log({ at: 'note-strip', sessionID: event.sessionID, removed: stripped })
        }
      }

      const est = estimate(event.messages) + estimate(event.system)
      // NOTE: s.prevEst (the sample calibration compares real usage against) is set at the end of
      // this block, AFTER pruning and after the pressure note was added. The provider reports usage
      // for the request that was actually sent. Comparing it with the pre-prune estimate made `cal`
      // shrink in proportion to the pruned share, so every later decision under-counted by the same
      // share and the 85% trigger fired far above the real ceiling.
      const cal = Number.isFinite(s.cal) && s.cal > 0 ? s.cal : 1
      // A real sample in the outgoing request beats any estimate: the provider reported the prompt
      // size on the last assistant message, so only the tail after it has to be estimated. This
      // holds even when calibration cannot read the transcript or the text is hard to estimate.
      const sample = lastPromptUsage(event.messages)
      let used = sample
        ? Math.round(sample.real + estimate(event.messages.slice(sample.index + 1)))
        : Math.round(est * cal)
      let ratio = used / CFG.limit

      if (event.options) {
        const room = CFG.ceiling - used - CFG.margin
        const current = typeof event.options.maxTokens === 'number' ? event.options.maxTokens : 32000
        event.options.maxTokens = Math.max(2000, Math.min(32000, current, room))
      }

      if ((s.ctxCalls = (s.ctxCalls || 0) + 1) <= 12) {
        let toolChars = 0
        let toolMsgs = 0
        for (const m of event.messages || []) {
          if (m?.role !== 'tool' || !Array.isArray(m.content)) continue
          toolMsgs += 1
          for (const p of m.content) if (p?.type === 'tool-result' && typeof p?.result?.value === 'string') toolChars += p.result.value.length
        }
        log({ at: 'ctx', sessionID: event.sessionID, used, est, cal, src: sample ? 'real' : 'est', ratio: Number(ratio.toFixed(3)), msgs: event.messages?.length, toolMsgs, toolChars })
      }

      // ---- adaptive pruning of stale tool output (outgoing request only) ----
      const forced = Boolean(s.forcePrune)
      if ((forced || ratio >= CFG.pruneSoft) && Array.isArray(event.messages)) {
        try {
        const tight = forced || ratio >= CFG.compact
        const keep = tight ? 6 : CFG.keepRecent
        const head = tight ? 2000 : ratio >= CFG.warn ? 3000 : 4000
        const tail = tight ? 600 : 1200
        const stop = Math.max(0, event.messages.length - keep)
        let saved = 0
        let touched = 0
        for (let i = 0; i < stop; i++) {
          const m = event.messages[i]
          if (!m || m.role !== 'tool' || !Array.isArray(m.content)) continue
          for (const p of m.content) {
            if (p?.type !== 'tool-result') continue
            const value = p?.result?.value
            if (p?.result?.type !== 'text' || typeof value !== 'string') continue
            if (value.includes('[omni-resilience]')) continue
            const before = value.length
            const next = headTail(value, head, tail)
            if (next.length !== before) {
              p.result.value = next
              saved += before - next.length
              touched += 1
            }
          }
        }
        if (saved > 0) {
          s.prunedChars += saved
          log({ at: 'prune', sessionID: event.sessionID, ratio: Number(ratio.toFixed(3)), messages: touched, saved, forced })
          used = Math.round((estimate(event.messages) + estimate(event.system)) * cal)
          ratio = used / CFG.limit
        }
        if (forced) {
          s.forcePrune = false
          log({ at: 'force-prune-done', sessionID: event.sessionID, saved })
        }
        } catch (e: any) {
          log({ at: 'prune-error', sessionID: event.sessionID, error: String(e?.message || e) })
        }
      }

      // ---- emergency trim: the session has to survive without compaction ----------
      // flash1047 cuts the summarisation stream, so compaction can fail again and again. After two
      // failures the plugin stops relying on it: every request above emergencyRatio gets its old
      // tool output and old assistant/reasoning text cut to a stub, the recent tail stays intact,
      // and one handoff note keeps the goal and .omo/state.md visible. No model call happens here,
      // so there is nothing for the provider to truncate.
      if (s.compactFails >= 2 && ratio >= CFG.emergencyRatio && Array.isArray(event.messages)) {
        try {
          const keepTail = 6
          const stop = Math.max(0, event.messages.length - keepTail)
          let saved = 0
          let touched = 0
          for (let i = 0; i < stop; i++) {
            const m = event.messages[i]
            if (!m || !Array.isArray(m.content)) continue
            if (m.role === 'tool') {
              for (const p of m.content) {
                const value = p?.result?.value
                if (p?.type !== 'tool-result' || p?.result?.type !== 'text' || typeof value !== 'string') continue
                if (value.includes('[omni-resilience]')) continue
                const next = headTail(value, 600, 200)
                if (next.length < value.length) {
                  saved += value.length - next.length
                  p.result.value = next
                  touched += 1
                }
              }
            } else if (m.role === 'assistant') {
              for (const p of m.content) {
                if (p?.type !== 'text' && p?.type !== 'reasoning') continue
                const value = typeof p?.text === 'string' ? p.text : ''
                if (value.length <= 800 || value.includes('[omni-resilience]')) continue
                p.text = value.slice(0, 600) + '\n[trimmed by omni-resilience: compaction unavailable]'
                saved += value.length - p.text.length
                touched += 1
              }
            }
          }
          if (saved > 0) {
            used = Math.round((estimate(event.messages) + estimate(event.system)) * cal)
            ratio = used / CFG.limit
            s.estimatedTokens = used
            log({ at: 'emergency-trim', sessionID: event.sessionID, saved, messages: touched, used, ratio: Number(ratio.toFixed(3)), fails: s.compactFails })
          }
          // The trimmed-away turns are gone for good, so the goal and the state file travel in the
          // request instead of a summary that was never written.
          let stateText = ''
          try {
            stateText = fs.readFileSync(path.join(root, '.omo', 'state.md'), 'utf8').trim().slice(0, 1500)
          } catch {}
          const goal = String(s.goal || s.lastInstruction || '').trim().slice(0, 400)
          event.messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  '[omni-resilience] Automatic note, not from the user. Automatic compaction is unavailable for ' +
                  'this session, so older turns were shortened to keep the request inside the context limit; the ' +
                  'recent tail is intact. ' +
                  (goal ? `The task is: "${goal}". ` : '') +
                  'Read .omo/goal.md and .omo/state.md before continuing, then take the next unfinished step. ' +
                  'Do not restart the task and do not invent new work.' +
                  (stateText ? `\n\nCurrent .omo/state.md:\n${stateText}` : ''),
              },
            ],
          })
        } catch (e: any) {
          log({ at: 'emergency-trim-error', sessionID: event.sessionID, error: String(e?.message || e) })
        }
      }

      s.estimatedTokens = used

      // Re-arm the level log when the context drops back under the warn line (compaction, a big
      // tool result pruned). Without this the first climb is the only one ever logged and a second
      // climb looks healthy in the log even though it is just as full.
      if (ratio < CFG.warn - 0.05 && Object.keys(s.marks).length) {
        s.marks = {}
        log({ at: 'warn-rearm', sessionID: event.sessionID, ratio: Number(ratio.toFixed(3)) })
      }

      // Context-pressure note. It used to be pushed into the system prompt exactly once per level:
      // the model saw it for a single step (it is never stored in the history) and the changing
      // system prompt invalidated the provider's prefix cache twice (when it appeared and when it
      // vanished). Now the note is present on EVERY request while the level holds, and by default it
      // is appended after the history, so the cached prefix stays byte-identical.
      const warn = (key: string, text: string) => {
        if (!s.marks[key]) {
          s.marks[key] = true
          log({ at: 'warn', sessionID: event.sessionID, key, used, ratio: Number(ratio.toFixed(3)), mode: CFG.warnMode })
        }
        if (CFG.warnMode === 'system') {
          // the same text may already be in the system prompt from an earlier request
          const present = (event.system || []).some((part: any) => part?.type === 'text' && part?.text === text)
          if (!present) event.system.push({ type: 'text', text })
        } else if (Array.isArray(event.messages)) {
          event.messages.push({ role: 'user', content: [{ type: 'text', text }] })
        }
      }

      const pct = (ratio * 100).toFixed(0)
      if (ratio >= CFG.hard) {
        warn(
          'hard',
          `[omni-resilience] Automatic note, not from the user. Context ${pct}% full. Close only the current step and write concrete state to .omo/state.md: files and paths, decisions, open TODOs, next step. Compaction follows immediately. Do not start new work in this turn and do not drop the task.`,
        )
      } else if (ratio >= CFG.compact) {
        warn(
          'compact',
          `[omni-resilience] Automatic note, not from the user. Context ${pct}% full. Keep the same quality bar: verify claims before writing them and do not skip steps because the context is filling up. Write concrete findings to .omo/state.md - exact paths, line numbers, symbol names, decisions, next step - because a summary is about to replace the history and it must carry them. If you need an old file again, read a range (grep, offset/limit) instead of the whole file.`,
        )
      } else if (ratio >= CFG.warn) {
        warn(
          'warn',
          `[omni-resilience] Automatic note, not from the user. Context ${pct}% full. Work at full quality: do not shorten answers, do not skip verification and do not skip steps because the context is filling up. Prefer targeted reads (grep, offset/limit) over re-reading whole files, and record findings - paths, line numbers, decisions, next step - in .omo/state.md so they survive compaction.`,
        )
      }

      // The sample calibration compares real usage against: exactly what is about to be sent.
      s.prevEst = estimate(event.messages) + estimate(event.system)

      if (s.compacting) {
        const since = s.compactingSince || s.lastCompactAt || Date.now()
        if (Date.now() - since > CFG.compactingTtlMs) {
          // the runtime normally ends compaction with an event; if that event never arrives the
          // flag would stay stuck and silently disable every future compaction
          s.compacting = false
          s.compactingSince = 0
          log({ at: 'compacting-watchdog', sessionID: event.sessionID, ageMs: Date.now() - since })
        }
      }

      // A failure must buy silence, not another attempt three minutes later. The summarisation
      // request is the longest one in a session, so it is the one the provider cuts; retrying it
      // on the normal cooldown turned one truncation into a compaction storm. The cooldown doubles
      // per consecutive failure: 3 min -> 6 -> 12 -> 24 -> 30 max.
      const compactBackoff =
        s.compactFails > 0 ? Math.min(1800000, CFG.cooldownMs * Math.pow(2, Math.min(4, s.compactFails))) : CFG.cooldownMs
      if (ratio >= CFG.compact && !s.compacting && Date.now() - s.lastCompactAt > compactBackoff) {
        // OpenCode 2.1.2 keeps the recent `compaction.keep` tokens (default 15 000) verbatim and
        // only summarises what is older. Below that floor the runtime answers "Nothing to compact
        // yet" (SessionCompaction.compaction.unavailable) and a tiny session cannot be compacted
        // at all. The floor is `keep + 3000` and must track compaction.keep.tokens, otherwise this
        // hook and the runtime disagree and the session spins on failed compactions.
        const keepFloor = Math.max(18000, CFG.keep + 3000)
        const msgs = Array.isArray(event.messages) ? event.messages : []
        // histLen was measured before our own tail note was appended - the note is not history
        const hasHistory = histLen >= 3 && msgs.some((m: any) => String(m?.role || m?.type || '') === 'assistant')
        if (used < keepFloor || !hasHistory) {
          log({ at: 'compact-skip', sessionID: event.sessionID, why: used < keepFloor ? 'below-keep-window' : 'no-history', used, keep: CFG.keep, floor: keepFloor, msgs: histLen })
          return
        }
        s.compacting = true
        s.lastCompactAt = Date.now()
        s.compactingSince = Date.now()
        if (!CFG.ownCompact) {
          if (!s.compactDelegated) {
            s.compactDelegated = true
            log({ at: 'compact-delegated', sessionID: event.sessionID, used })
          }
          return
        }
        log({ at: 'compact-request', sessionID: event.sessionID, used })
        // compact() can throw synchronously (2.1.2 does exactly that when there is nothing to
        // compact); inside a hook that becomes a run-killing error, so always route it through
        // a promise chain and keep the failure local.
        void Promise.resolve()
          .then(() => ctx.session.compact({ sessionID: event.sessionID }))
          .then(() => log({ at: 'compact-admitted', sessionID: event.sessionID }))
          .catch((e: any) => {
            s.compacting = false
            const msg = String(e?.message || e)
            // "Nothing to compact yet" means the keep window swallowed the whole history. The old
            // code reset lastCompactAt to 0, so the very next request retried and a mismatched
            // keep value turned into a compaction storm (every request, forever). Keep the
            // timestamp and let the normal cooldown absorb it.
            s.lastCompactAt = Date.now()
            if (/nothing to compact/i.test(msg)) s.compactEmpty = (s.compactEmpty || 0) + 1
            else s.compactEmpty = 0
            log({ at: 'compact-error', sessionID: event.sessionID, error: msg, keep: CFG.keep, empty: s.compactEmpty || 0 })
          })
      }
    })

    await ctx.session.hook('compaction', (event: any) => {
      const s = get(event.sessionID)
      if (!ours(s)) return
      let stateText = ''
      try {
        stateText = fs.readFileSync(path.join(root, '.omo', 'state.md'), 'utf8').slice(0, 2500)
      } catch {}
      const task = String(s.goal || s.lastPrompt || '').trim().slice(0, 1500)
      const recent = (s.recent || []).slice(-6).join(', ') || 'none'

      // Pull the hard facts out of the transcript itself: a summariser that is handed the user's
      // exact words, the files, the commands and the errors keeps them in the summary. One that
      // only gets a tool counter paraphrases the request into something generic, which is exactly
      // how "он не помнит, как именно я просил" happens between compactions.
      const facts = {
        files: [] as string[],
        tools: [] as string[],
        lastStep: '',
        asks: [] as string[],
        commands: [] as string[],
        errors: [] as string[],
      }
      try {
        const msgs = Array.isArray(event.messages) ? event.messages : []
        let last = ''
        for (const m of msgs) {
          if (!m || !Array.isArray(m.content)) continue
          const role = String(m.role || m.type || '')
          for (const p of m.content) {
            if (!p) continue
            if (p.type === 'tool-call' || p.type === 'tool' || p.type === 'tool-invocation') {
              const name = String(p.name || p.toolName || '').trim()
              if (name && !facts.tools.includes(name)) facts.tools.push(name)
              const args = p.input || p.args || p.arguments
              if (args && typeof args === 'object') {
                const pth = args.filePath || args.path || args.file || args.filename || args.target
                if (typeof pth === 'string' && pth) {
                  const from = [args.offset, args.startLine, args.start].find((v: any) => Number.isFinite(Number(v)))
                  const to = [args.limit, args.endLine, args.end].find((v: any) => Number.isFinite(Number(v)))
                  const ref =
                    from !== undefined
                      ? `${pth}:${from}${to !== undefined ? '-' + (Number(from) + Number(to) - 1) : ''}`
                      : pth
                  if (!facts.files.includes(ref)) facts.files.push(ref)
                }
                const cmd = args.command || args.cmd
                if (typeof cmd === 'string' && cmd.trim() && !facts.commands.includes(cmd.trim())) {
                  facts.commands.push(cmd.trim().slice(0, 180))
                }
              }
            }
            if (p.type === 'text' && role === 'assistant' && String(p.text || '').trim()) {
              last = String(p.text).trim()
            }
            if (p.type === 'tool-result' && typeof p?.result?.value === 'string') {
              const line = String(p.result.value)
                .slice(0, 20000)
                .split(/\r?\n/)
                .find((l: string) => /error|failed|exception|cannot|not found|traceback/i.test(l))
              if (line && !facts.errors.includes(line.trim())) facts.errors.push(line.trim().slice(0, 180))
            }
          }
          // The user's own words are the requirements. A summary that paraphrases them loses what
          // was actually asked for, so the last few are carried verbatim. An extension of an
          // earlier ask (same prefix) replaces it: otherwise one reworded demand eats three of the
          // four slots and a second requirement never makes it into the summary.
          if (role === 'user') {
            const text = m.content
              .filter((p: any) => p?.type === 'text')
              .map((p: any) => String(p.text || ''))
              .join('\n')
              .trim()
            if (text && !/^\[omni-resilience\]/.test(text) && !isAddition(text)) {
              facts.asks = pushAsk(facts.asks, text.slice(0, 500))
            }
          }
        }
        facts.lastStep = last.slice(0, 700)
        facts.files = facts.files.slice(-10)
        facts.tools = facts.tools.slice(-8)
        facts.asks = facts.asks.slice(-4)
        facts.commands = facts.commands.slice(-5)
        facts.errors = facts.errors.slice(-3)
      } catch {}

      const allGoalAdds: string[] = (Array.isArray(s.additions) ? s.additions : [])
        .map((a: string) => String(a || '').trim())
        .filter(Boolean)
      const goalAdds = allGoalAdds.slice(-2)
      const note =
        `[omni-resilience] Facts that MUST survive this compaction (session ${event.sessionID}). ` +
        (task ? `The user's TASK, verbatim: "${task}". ` : '') +
        (goalAdds.length
          ? `Context the user added on top of the task (hold in mind, NOT tasks): ${goalAdds
              .map((a) => `"${a}"`)
              .join(' | ')}. ` +
            (allGoalAdds.length > goalAdds.length
              ? `${allGoalAdds.length - goalAdds.length} earlier addition${allGoalAdds.length - goalAdds.length === 1 ? '' : 's'} are in .omo/goal.md under "Additions" - keep them. `
              : '')
          : '') +
        (facts.asks.length
          ? `The user's own words, in order (these ARE the requirements): ${facts.asks.map((a) => `"${a}"`).join(' | ')}. `
          : '') +
        `Work done so far: ${s.toolCount} tool calls; recent tools: ${recent}; last tool: ${s.lastTool}. ` +
        (facts.tools.length ? `Tools used: ${facts.tools.join(', ')}. ` : '') +
        (facts.files.length ? `Files touched (exact paths, with line ranges where known): ${facts.files.join(', ')}. ` : '') +
        (facts.commands.length ? `Commands run: ${facts.commands.map((c) => '`' + c + '`').join('; ')}. ` : '') +
        (facts.errors.length ? `Errors seen verbatim: ${facts.errors.map((e) => `"${e}"`).join('; ')}. ` : '') +
        (facts.lastStep ? `Last visible step: "${facts.lastStep}". ` : '') +
        `When you write the summary you MUST keep, word for word: the user's requirements above, every file path and line ` +
        `number, every symbol/function/table name, the commands and their outcomes, the error messages, the decisions with ` +
        `their reason, the open TODOs and the next concrete step. Do not paraphrase the user's requirements and do not ` +
        `replace concrete paths with descriptions like "the config file". ` +
        `Checkpoint: .omo/checkpoints/${event.sessionID}.json. ` +
        (stateText ? `\n\nCurrent .omo/state.md:\n${stateText}` : '')
      try {
        const msgs = event.messages
        let target = 'none'
        if (Array.isArray(msgs)) {
          // Rule: hooks never rewrite an existing message. Adding a text part to a `tool`
          // message made the whole request invalid on strict protocols (OpenAI Chat:
          // "tool messages only support tool-result content for now"), and appending to an
          // assistant message put instructions inside the model's own past output. A fresh
          // user message at the end is legal on every protocol and is what the summarizer
          // reads last, so it is the only injection point used here.
          msgs.push({ role: 'user', content: [{ type: 'text', text: note }] })
          target = 'user:new'
        }
        log({
          at: 'compaction-note',
          sessionID: event.sessionID,
          injected: true,
          state: stateText.length,
          target,
        })
      } catch (e: any) {
        log({ at: 'compaction-note-error', error: String(e?.message || e) })
      }
    })

    await ctx.session.hook('retry', async (event: any) => {
      const s = get(event.sessionID)
      if (event.model?.id) s.modelID = event.model.id
      if (event.model?.providerID) s.providerID = event.model.providerID
      if (!(await manage(event.sessionID, s))) return
      const status = event.error?.status
      const type = String(event.error?.type || '')
      const msg = String(event.error?.message || '')
      const blob = `${type} ${msg}`
      log({ at: 'retry-hook', sessionID: event.sessionID, status, type, attempt: event.attempt, model: modelKey(s) })
      // our own stall interrupt is not a network failure - never retry it
      if (/step interrupted|request aborted by user|interrupted by user/i.test(msg)) return

      // A 4xx that says the model is unavailable/unknown is a wrong model id, not an outage.
      // Check it before the generic `unavailable` pattern below, otherwise it is retried for the
      // whole backoff budget (and the resume path then fires on top of it).
      const clientError =
        typeof status === 'number' && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)
      if (clientError && MODEL_CONFIG_RE.test(blob)) {
        log({ at: 'retry-fatal', sessionID: event.sessionID, status, type, message: msg.slice(0, 160) })
        s.retryGiveup = Date.now()
        return
      }

      // A stream that stops before its final chunk is a transport failure even though it arrives as
      // HTTP 200 and often has no status at all: the socket is fine, the body just ends. OpenCode
      // reports it as `provider.invalid-output` with "OpenAI Chat stream ended without finish_reason"
      // (or "Invalid ... stream event" when a chunk is cut mid-frame). The free gateway does this on
      // long reasoning streams; without this pattern the step fails with no retry.
      const transport =
        /transport|econnreset|connection lost|socket|premature|network error|fetch failed|closed unexpectedly|invalid-output|stream ended|without finish_reason|stream event|unexpected end of|incomplete (stream|response)/i.test(
          blob,
        )
      const isRate = status === 429 || /rate.?limit|too many requests|quota/i.test(blob)
      const endpointDead =
        (typeof status === 'number' && status >= 500) ||
        /endpoint is unavailable|upstream request failed|unavailable|overload|no route|internal/i.test(blob)
      const transient =
        transport ||
        isRate ||
        endpointDead ||
        status === 408 ||
        status === 409 ||
        status === 425 ||
        /timeout|network|fetch|econn|socket/i.test(blob)
      if (!transient) return

      const now = Date.now()
      if (!s.retryStart || now - s.retryStart > 120000) {
        s.retryStart = now
        s.retryCount = 0
      }
      s.retryCount = (s.retryCount || 0) + 1

      // --- 1) transport blip: same model, dense retry, smaller request -------------
      if (transport) {
        s.transportFails = (s.transportFails || 0) + 1
        if (s.transportFails === 2) s.forcePrune = true
        log({ at: 'transport-fail', sessionID: event.sessionID, count: s.transportFails, status, message: msg.slice(0, 160) })
        // a stream that keeps dying mid-flight will not heal by retrying forever:
        // six attempts cover a normal blip, the seventh means the gateway is down or the request
        // is too big to survive, so let the failure path (resume/compaction) take over
        if (s.transportFails >= CFG.maxTransportFails) {
          log({ at: 'retry-giveup', sessionID: event.sessionID, count: s.transportFails })
          s.retryGiveup = now
          s.transportFails = 0
          return
        }
        const delay = Math.min(8000, 1200 * Number(event.attempt || 1))
        event.decision = { retry: true, delay }
        log({ at: 'retry', sessionID: event.sessionID, reason: 'transport', delay, count: s.retryCount })
        return
      }

      // --- 2) backoff on this model only. No switching: the session keeps the model the user
      // picked. A 429 waits longer, a 5xx/overload waits shorter, a dead endpoint eventually
      // gives up and lets the failure path (resume prompt) surface it instead of hiding it.
      const elapsed = now - s.retryStart
      const budget = isRate ? 60000 : 45000
      if (elapsed > budget) {
        log({ at: 'retry-giveup', sessionID: event.sessionID, elapsed, budget, count: s.retryCount, status, type })
        s.retryStart = 0
        s.retryCount = 0
        // do not let the resume path start a second 45 s round against a dead endpoint
        s.retryGiveup = now
        return
      }
      // smaller request = cheaper retry: the free pool answers big prompts last
      if (s.retryCount >= 2) s.forcePrune = true
      const delay = isRate
        ? Math.min(15000, 3000 * Math.pow(2, Math.max(0, s.retryCount - 1)) * 0.6)
        : Math.min(2500, 700 + 400 * s.retryCount)
      event.decision = { retry: true, delay }
      log({
        at: 'retry',
        sessionID: event.sessionID,
        status,
        type,
        delay,
        isRate,
        endpointDead,
        count: s.retryCount,
        elapsed,
      })
    })

    try {
      if (!shared.subscribed) {
        shared.subscribed = true
        void (async () => {
        for await (const ev of ctx.event.subscribe()) {
          try {
            const type = ev.type
            const d: any = (ev as any).data || {}
            const id = d.sessionID || (ev as any).sessionID
            if (!id) continue
            const s = get(id)

            // ---- scope guard: resolve the model for events that arrive before a context hook ----
            if (!ours(s)) await ensureModel(id, s)
            if (!ours(s)) continue

            s.lastEventAt = Date.now()
            s.seen = s.seen || {}
            if (!s.seen[type]) {
              s.seen[type] = true
              log({ at: 'event-type', type, sessionID: id })
            }

            if (type === 'session.tool.called') {
              if (d.id) s.pending.add(d.id)
            } else if (type === 'session.tool.success' || type === 'session.tool.failed') {
              if (d.id) s.pending.delete(d.id)
              s.toolCount += 1
              s.lastTool = d.name || d.tool || s.lastTool
              if (s.lastTool && s.lastTool !== 'none') {
                s.recent = [...(s.recent || []), String(s.lastTool)].slice(-8)
              }
              if (type === 'session.tool.success' && s.toolCount % CFG.every === 0) await writeCheckpoint(id, `every-${CFG.every}`)
              void refreshCalibration(id)
            } else if (type === 'session.execution.started') {
              s.busy = true
              s.inflight = true
              s.stalled = false
              s.retryGiveup = 0
            } else if (type === 'session.execution.succeeded') {
              s.busy = false
              s.inflight = false
              s.retryCount = 0
              s.retryStart = 0
              s.transportFails = 0
              s.forcePrune = false
              log({ at: 'succeeded', sessionID: id, model: modelKey(s) })
              void refreshCalibration(id)
              await writeCheckpoint(id, 'execution-succeeded')
            } else if (type === 'session.execution.failed') {
              s.busy = false
              s.inflight = false
              const retries = s.retryCount || 0
              s.retryCount = 0
              s.retryStart = 0
              const fatal = FATAL_RE
              if (retries > 0 && !fatal.test(s.lastError)) void resume(id, 'failed after ' + retries + ' retries')
              await writeCheckpoint(id, 'execution-failed')
            } else if (type === 'session.execution.interrupted') {
              s.busy = false
              s.inflight = false
              s.retryCount = 0
              s.retryStart = 0
            } else if (type === 'session.step.ended' || type === 'session.text.ended') {
              // a step finished: the stream is no longer in flight, re-arm on the next started event
              s.inflight = false
            } else if (type === 'session.step.failed') {
              if (d.error) {
                const et = String(d.error?.type || '')
                const em = String(d.error?.message || '')
                s.lastError = et || em || s.lastError
                // counting/retry decisions live in the retry hook, which sees every attempt exactly once
              }
            } else if (type === 'session.status') {
              const st = String(d.status?.type || d.status || '')
              s.busy = /busy|running|retry/i.test(st)
              if (!s.busy) s.inflight = false
              else s.stalled = false
            } else if (type === 'session.error') {
              s.lastErrorAt = Date.now()
              s.lastError = String(d.error?.type || d.error?.message || 'error')
              log({ at: 'error', sessionID: id, type: s.lastError })
            } else if (type === 'session.retry.scheduled') {
              // counting happens once, in the retry hook - this event is informational only
              log({ at: 'retry-scheduled', sessionID: id, attempt: d.attempt, count: s.retryCount })
            } else if (type === 'session.compaction.started') {
              s.compacting = true
              s.compactingSince = Date.now()
              await writeCheckpoint(id, 'pre-compaction')
            } else if (type === 'session.compaction.ended' || type === 'session.compaction.failed') {
              s.compacting = false
              s.compactingSince = 0
              s.compactEmpty = 0
              s.marks = {}
              if (type === 'session.compaction.failed') {
                // Count consecutive failures and let the backoff start from the failure, not from
                // the request that was issued minutes earlier: that is what made the old cooldown
                // expire exactly when the next user message arrived.
                s.compactFails = Number(s.compactFails || 0) + 1
                s.emergency = s.compactFails >= 2
                s.lastCompactAt = Date.now()
                log({
                  at: 'compact-backoff',
                  sessionID: id,
                  fails: s.compactFails,
                  emergency: s.emergency,
                  nextTryMs: Math.min(1800000, CFG.cooldownMs * Math.pow(2, Math.min(4, s.compactFails))),
                })
              } else {
                s.compactFails = 0
                s.emergency = false
              }
              // re-anchor the model on the next request: compaction moves the conversation into a
              // summary, which is exactly where agents drift into invented work
              if (type === 'session.compaction.ended') {
                s.anchor = { at: Date.now(), reason: 'compaction' }
                s.anchorLeft = 2
                // A summary ends the turn: OpenCode does not continue on its own. Send one short
                // prompt so the model keeps working instead of waiting for the user to type
                // "continue" and hope. Only into an idle session, at most 3 times, 60 s apart.
                setTimeout(async () => {
                  try {
                    const st: any = await ctx.session.get({ sessionID: id })
                    if (st?.status?.type !== 'idle') return
                    const cur = get(id)
                    if (!ours(cur)) return
                    if (Date.now() - Number(cur.lastAutoContinue || 0) < 60000) return
                    if (Number(cur.autoContinues || 0) >= 3) return
                    cur.lastAutoContinue = Date.now()
                    cur.autoContinues = Number(cur.autoContinues || 0) + 1
                    await ctx.session.prompt({
                      sessionID: id,
                      text:
                        '[omni-resilience] Continue the task now. Do not summarise and do not stop to ask. ' +
                        'Read .omo/goal.md and .omo/state.md, then take the next unfinished step.',
                    })
                    log({ at: 'auto-continue', sessionID: id, attempt: cur.autoContinues })
                  } catch (e: any) {
                    log({ at: 'auto-continue-error', sessionID: id, error: String(e?.message || e) })
                  }
                }, 1500)
              }
              await writeCheckpoint(id, type.endsWith('failed') ? 'compaction-failed' : 'post-compaction')
            } else if (type === 'session.idle') {
              s.busy = false
              s.inflight = false
              const fatal = FATAL_RE
              let outcome = ''
              try {
                const info: any = await ctx.session.get({ sessionID: id })
                outcome = String(info?.outcome ?? info?.data?.outcome ?? '')
              } catch {}
              const retries = s.retryCount || 0
              s.retryCount = 0
              const gaveUp = s.retryGiveup && Date.now() - s.retryGiveup < 180000
              if (outcome === 'failed' && retries > 0 && !fatal.test(s.lastError) && !gaveUp) {
                void resume(id, 'failed after ' + retries + ' retries')
              } else if (gaveUp) {
                log({ at: 'resume-skip', sessionID: id, why: 'retry-budget-exhausted' })
              }
              await writeCheckpoint(id, 'idle')
            }
          } catch (e: any) {
            log({ at: 'event-error', error: String(e?.message || e) })
          }
        }
        })()
      }
    } catch (e: any) {
      log({ at: 'subscribe-error', error: String(e?.message || e) })
    }

    if (!shared.timerStarted && CFG.stallMs > 0) {
      shared.timerStarted = true
      let ticking = false
      const timer = setInterval(() => {
        if (ticking) return
        ticking = true
        void (async () => {
          try {
            const now = Date.now()
            for (const [id, s] of state) {
              if (!ours(s)) continue
              if (!s.inflight || s.stalled || s.pending.size > 0) continue
              if (now - (s.lastEventAt || now) < CFG.stallMs) continue
              const st = await sessionState(id)
              if (!st.running) {
                s.inflight = false
                log({ at: 'stall-skip', sessionID: id, why: 'not-running', status: st.status, outcome: st.outcome })
                continue
              }
              if (!(await needsContinuation(id))) {
                s.inflight = false
                log({ at: 'stall-skip', sessionID: id, why: 'answer-present' })
                continue
              }
              s.stalled = true
              log({ at: 'stall', sessionID: id, idleMs: now - s.lastEventAt, status: st.status })
              try {
                await ctx.session.interrupt({ sessionID: id })
              } catch (e: any) {
                log({ at: 'stall-error', sessionID: id, error: String(e?.message || e) })
              }
              await new Promise((r) => setTimeout(r, 4000))
              const after = await sessionState(id)
              if (after.running) {
                log({ at: 'stall-resolved', sessionID: id, why: 'still-streaming' })
                s.stalled = false
                continue
              }
              // the interrupt itself closes the turn as 'interrupted', so resume() checks
              // for real assistant prose instead of the idle marker
              void resume(id, 'stream stall', true)
            }
          } catch (e: any) {
            log({ at: 'timer-error', error: String(e?.message || e) })
          } finally {
            ticking = false
          }
        })()
      }, 30000)
      if (typeof (timer as any).unref === 'function') (timer as any).unref()
    }

    log({
      at: 'setup',
      plugin: VERSION,
      pid: typeof process !== 'undefined' ? process.pid : 0,
      root,
      guarded: GUARDED,
      limit: CFG.limit,
      warn: CFG.warn,
      compact: CFG.compact,
      hard: CFG.hard,
      ceiling: CFG.ceiling,
      margin: CFG.margin,
      keep: CFG.keep,
      keepFloor: Math.max(18000, CFG.keep + 3000),
      stallMs: CFG.stallMs,
      maxResumes: CFG.maxResumes,
      maxTransportFails: CFG.maxTransportFails,
      modelSwitching: 'disabled',
      estimator: `${ASCII_PER_TOKEN} ascii/char, ${WIDE_PER_TOKEN} wide/char, calibrated`,
    })
  },
}
