import { atom, read, update } from 'claude-code'
import type { Register, SessionMeasureInput } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-line', key: 'usage' } as const, {})
const lastActivity = atom({ plugin: 'usage-line', key: 'lastActivity' } as const, null)
// Bumped every minute so the cache timer redraws.
const tick = atom({ plugin: 'usage-line', key: 'tick' } as const, 0)

// Warn once per level, per session. Context % is what each message re-reads; usd is /cost's API-price estimate.
const CONTEXT_WARN = [40, 60, 80]
const USD_WARN = [5, 10, 20]

// Band palette.
const BAND_BG = '#24221e'
const LABEL = '#ece8df'
const MUTED = '#8c877d'
const WEEK = '#e07b39'
const FIVE_HOUR = '#e6b84a'
const CONTEXT = '#7fb8d6'
const WARM = '#7cbf6a'
const COOLING = '#5fb8b0'
const COLD = '#5b9bf0'
const DOTS = 10

// Pro's prompt cache lives about an hour; warn a bit before.
const CACHE_COOLING_MIN = 45
const CACHE_COLD_MIN = 60

const toUsage = (m: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>): Usage => {
  const five = m.rateLimits.find(r => r.kind === 'five_hour')
  const week = m.rateLimits.find(r => r.kind === 'seven_day')
  return {
    fiveHour: five?.percentUsed,
    fiveHourResetsAt: five?.resetsAt,
    week: week?.percentUsed,
    weekResetsAt: week?.resetsAt,
    contextPct: m.context.percent,
    usd: m.cost?.usd,
  }
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
    u.usd !== undefined && `$${u.usd.toFixed(2)}`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

export const register: Register = on => {
  const warned = new Set<string>()

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const u = toUsage(await $.session.usage())
    await update($, usage, () => u)
    $.clock.every(60_000, () => void update($, tick, n => n + 1))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lastActivity, () => now)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lastActivity, () => now)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const u = toUsage(e)
    await update($, usage, () => u)
    for (const level of CONTEXT_WARN) {
      if ((u.contextPct ?? 0) >= level && !warned.has(`c${level}`)) {
        warned.add(`c${level}`)
        $.ui.toast(`Session context at ${Math.round(u.contextPct!)}%: every message re-reads it. Consider /handoff then /clear, or /compact.`)
      }
    }
    for (const level of USD_WARN) {
      if ((u.usd ?? 0) >= level && !warned.has(`u${level}`)) {
        warned.add(`u${level}`)
        $.ui.toast(`This session has cost about $${u.usd!.toFixed(2)} so far.`)
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
    const { Box, Text } = $.ui.resolve(e)

    const meter = (key: string, label: string, used: number | undefined, resetsAt: string | undefined, color: string) => {
      if (used === undefined) return null
      const pct = Math.min(100, Math.max(0, Math.round(used)))
      const filled = Math.round((pct / 100) * DOTS)
      const reset = untilReset(resetsAt, now)
      return (
        <Box key={key} flexDirection="row" alignItems="center" gap="sm">
          <Text mono weight="semibold" color={MUTED}>{label}</Text>
          <Text mono>
            <Text color={color}>{'●'.repeat(filled)}</Text>
            <Text color={MUTED}>{'·'.repeat(DOTS - filled)}</Text>
          </Text>
          <Text mono weight="bold" color={color}>{pct}%</Text>
          {reset ? <Text mono color={MUTED}>· {reset}</Text> : null}
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
        <Box key="cache" flexDirection="row" alignItems="center" gap="sm">
          <Text mono weight="semibold" color={MUTED}>CACHE</Text>
          <Text mono weight="bold" color={color}>{state}</Text>
          <Text mono color={MUTED}>· {age}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="row" alignItems="center" gap="lg" paddingX="md" paddingY={0} backgroundColor={BAND_BG}>
        <Text mono weight="bold" color={LABEL}>USAGE</Text>
        {meter('five', '5H', u.fiveHour, u.fiveHourResetsAt, FIVE_HOUR)}
        {meter('week', '7D', u.week, undefined, WEEK)}
        {cache}
        {meter('ctx', 'CTX', u.contextPct, undefined, CONTEXT)}
      </Box>
    )
  })
}
