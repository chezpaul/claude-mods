import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, {})
const lastActivity = atom({ plugin: 'usage-line', key: 'lastActivity' } as const, null)
// Bumped every minute so the cache timer redraws.
const tick = atom({ plugin: 'usage-line', key: 'tick' } as const, 0)

// Warn once per level: context per session (what each message re-reads), 5-hour limit per window.
const CONTEXT_WARN = [40, 60, 80]
const FIVE_HOUR_WARN = [50, 75, 90]

// Band palette.
const LABEL = '#ece8df'
const MUTED = '#8c877d'
const WEEK = '#e07b39'
const FIVE_HOUR = '#e6b84a'
const CONTEXT = '#7fb8d6'
const WARM = '#7cbf6a'
const COOLING = '#5fb8b0'
const COLD = '#5b9bf0'

// Pro's prompt cache lives about an hour; warn a bit before.
const CACHE_COOLING_MIN = 45
const CACHE_COLD_MIN = 60
// Below this a cold re-read is cheap enough not to interrupt.
const COLD_PROMPT_MIN_TOKENS = 50_000

// A handoff skill may be installed bare (`handoff`) or namespaced by a plugin or synced account (`anthropic-skills:handoff`).
const runHandoff = async ($: EngineInterface) => {
  const names = (await $.command.list()).map(c => c.name)
  const command = names.find(n => n === 'handoff') ?? names.find(n => n.endsWith(':handoff'))
  if (command) await $.command.run({ command })
  else $.ui.toast('No handoff skill or command installed.')
}

// `compactAt` is the window auto-compaction measures against (what the app's Context % uses), smaller than the model's.
const toUsage = (m: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>, compactAt?: number): Usage => {
  const five = m.rateLimits.find(r => r.kind === 'five_hour')
  const week = m.rateLimits.find(r => r.kind === 'seven_day')
  return {
    fiveHour: five?.percentUsed,
    fiveHourResetsAt: five?.resetsAt,
    week: week?.percentUsed,
    weekResetsAt: week?.resetsAt,
    contextPct: m.context.tokens !== undefined && compactAt ? Math.round((m.context.tokens / compactAt) * 100) : m.context.percent,
    contextTokens: m.context.tokens,
    usd: m.cost?.usd,
  }
}

type Limits = Pick<Usage, 'fiveHour' | 'fiveHourResetsAt' | 'week' | 'weekResetsAt'>
const LIMITS_KEY = 'limits'

// Limits are account-wide but only arrive with an API reply, so a new or reopened thread
// starts from the last ones seen in any session. A window whose reset has passed starts at 0.
async function withLimits($: EngineInterface, u: Usage, now: number): Promise<Usage> {
  if (u.fiveHour !== undefined || u.week !== undefined) {
    const limits: Limits = { fiveHour: u.fiveHour, fiveHourResetsAt: u.fiveHourResetsAt, week: u.week, weekResetsAt: u.weekResetsAt }
    await $.store.set(LIMITS_KEY, limits)
    return u
  }
  const saved = (await $.store.get(LIMITS_KEY)) as Limits | undefined
  if (!saved) return u
  const expired = (at?: string) => at !== undefined && Date.parse(at) <= now
  return {
    ...u,
    fiveHour: expired(saved.fiveHourResetsAt) ? 0 : saved.fiveHour,
    fiveHourResetsAt: expired(saved.fiveHourResetsAt) ? undefined : saved.fiveHourResetsAt,
    week: expired(saved.weekResetsAt) ? 0 : saved.week,
    weekResetsAt: expired(saved.weekResetsAt) ? undefined : saved.weekResetsAt,
  }
}

// Each thread's last activity, by session id, so a reopened thread shows its cache age at once.
const ACTIVITY_KEY = 'lastActivity'
const ACTIVITY_KEEP = 200

async function saveActivity($: EngineInterface, at: number) {
  await update($, lastActivity, () => at)
  const id = await $.session.id()
  const all = ((await $.store.get(ACTIVITY_KEY)) ?? {}) as Record<string, number>
  delete all[id]
  all[id] = at
  const ids = Object.keys(all)
  for (const old of ids.slice(0, Math.max(0, ids.length - ACTIVITY_KEEP))) delete all[old]
  await $.store.set(ACTIVITY_KEY, all)
}

function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${mins % 60}m`
}

function toLine(u: Usage): string | undefined {
  const parts = [
    u.fiveHour !== undefined && `5h ${Math.round(u.fiveHour)}%`,
    u.week !== undefined && `week ${Math.round(u.week)}%`,
    u.contextPct !== undefined && `ctx ${Math.round(u.contextPct)}%`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

export const register: Register = on => {
  const warned = new Set<string>()

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const full = await $.session.usage({ breakdown: 'summary' })
    const u = await withLimits($, toUsage(full, full.context.breakdown?.rawMaxTokens), await $.clock.now())
    await update($, usage, () => u)
    if ((await read($, lastActivity)) === null) {
      const saved = ((await $.store.get(ACTIVITY_KEY)) ?? {}) as Record<string, number>
      const at = saved[await $.session.id()]
      if (at !== undefined) await update($, lastActivity, () => at)
    }
    $.clock.every(60_000, async () => {
      await update($, tick, n => n + 1)
      const last = await read($, lastActivity)
      const tokens = (await read($, usage)).contextTokens ?? 0
      const mins = last === null ? 0 : Math.floor(((await $.clock.now()) - last) / 60_000)
      if (mins === CACHE_COOLING_MIN && tokens >= COLD_PROMPT_MIN_TOKENS) {
        $.ui.toast(`Cache cools in ${CACHE_COLD_MIN - mins} min. Stepping away? Run /handoff now while it's cheap.`)
      }
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const last = await read($, lastActivity)
    await saveActivity($, now)

    // Cold cache + big context: the next message re-reads it all at full price.
    const isColdReturn = !e.isMeta && !e.command && last !== null && now - last >= CACHE_COLD_MIN * 60_000
    if (isColdReturn) {
      const tokens = (await $.session.usage()).context.tokens ?? 0
      if (tokens >= COLD_PROMPT_MIN_TOKENS) {
        const mins = Math.floor((now - last) / 60_000)
        const away = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
        const choice = await $.ui
          .ask(`Cache is cold (${away} since the last message). Sending re-reads ~${Math.round(tokens / 1000)}k tokens at full price. Send anyway?`, {
            header: 'Cold cache',
            options: ['Send anyway', 'Start fresh instead'],
          })
          .catch(() => 'Send anyway')
        // /handoff here would itself re-read the cold chat, so the cheap way out is a fresh start.
        if (choice === 'Start fresh instead') {
          $.ui.toast('Not sent. Run /clear, then send your message with a few lines of context.')
          return { drop: 'Cold cache: start fresh instead' }
        }
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await saveActivity($, await $.clock.now())
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // `summary` estimates locally: no API call.
    const compactAt = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.rawMaxTokens
    const u = await withLimits($, toUsage(e, compactAt), await $.clock.now())
    await update($, usage, () => u)
    for (const level of CONTEXT_WARN) {
      if ((u.contextPct ?? 0) >= level && !warned.has(`c${level}`)) {
        warned.add(`c${level}`)
        $.ui.toast(`Session context at ${Math.round(u.contextPct!)}%: every message re-reads it. Consider /handoff then /clear, or /compact.`)
      }
    }
    for (const level of FIVE_HOUR_WARN) {
      // Keyed by the window's reset time so a fresh 5-hour window warns again.
      const key = `f${level}-${u.fiveHourResetsAt}`
      if ((u.fiveHour ?? 0) >= level && !warned.has(key)) {
        warned.add(key)
        const reset = untilReset(u.fiveHourResetsAt, Date.now())
        $.ui.toast(`5-hour limit ${Math.round(u.fiveHour!)}% used${reset ? `, resets in ${reset}` : ''}.`)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = toLine(await read($, usage))
    if (!line) return next(e)

    // The terminal draws `tail` after its own hint; other surfaces need our own tree.
    if (e.surface === 'terminal') return next({ ...e, props: { ...e.props, tail: `  ${line}` } })
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.hint ? `${e.props.hint}  ·  ${line}` : line}</Text>
  })

  // The desktop Code tab doesn't raise PromptHint; the band above the prompt is where it shows there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    if (u.week === undefined && u.fiveHour === undefined) return next(e)
    const now = await $.clock.now()
    await read($, tick)
    const last = await read($, lastActivity)
    const { Box, Button, Text } = $.ui.resolve(e)

    const meter = (key: string, label: string, used: number | undefined, color: string) => {
      if (used === undefined) return null
      const pct = Math.min(100, Math.max(0, Math.round(used)))
      return (
        <Box key={key} flexDirection="row" alignItems="center" gap="xs" flexShrink={0}>
          <Text mono weight="semibold" color={MUTED}>{label}</Text>
          <Text mono weight="bold" color={color}>{pct}%</Text>
        </Box>
      )
    }

    let cache = null
    if (last !== null) {
      const mins = Math.floor((now - last) / 60000)
      const state = mins >= CACHE_COLD_MIN ? 'Cold' : mins >= CACHE_COOLING_MIN ? 'Cooling' : 'Warm'
      const color = state === 'Cold' ? COLD : state === 'Cooling' ? COOLING : WARM
      const age = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
      cache = (
        <Box key="cache" flexDirection="row" alignItems="center" gap="xs" flexShrink={0}>
          <Text mono weight="semibold" color={MUTED}>CACHE</Text>
          <Text mono weight="bold" color={color}>{state}</Text>
          <Text mono color={MUTED}>{age}</Text>
        </Box>
      )
    }

    return (
      // No background of our own: the desktop draws the band's card and a fill here showed as a strip inside it.
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap="md" paddingX="md" paddingY={0}>
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap="md" flexGrow={1}>
          <Text mono weight="bold" color={LABEL}>USAGE</Text>
          {meter('five', '5H', u.fiveHour, FIVE_HOUR)}
          {meter('week', '7D', u.week, WEEK)}
          {cache}
          {meter('ctx', 'CTX', u.contextPct, CONTEXT)}
        </Box>
        {/* Runs the installed handoff command, as typing it + Return would. */}
        {/* The desktop draws a Button's frame its own way; the label's style is ours. */}
        <Box flexShrink={0}>
          <Button key="handoff" label="HANDOFF" onPress={() => void runHandoff($)}>
            <Text mono weight="bold" color={CONTEXT}>HANDOFF</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
