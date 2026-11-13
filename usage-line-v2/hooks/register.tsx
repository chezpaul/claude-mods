import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionMeasureInput } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-line-v2', key: 'usage' } as const, {})
const lastActivity = atom({ plugin: 'usage-line-v2', key: 'lastActivity' } as const, null)
// Bumped every minute so the countdowns redraw.
const tick = atom({ plugin: 'usage-line-v2', key: 'tick' } as const, 0)

// Warn once per level: context per session (what each message re-reads), 5-hour limit per window.
const CONTEXT_WARN = [40, 60, 80]
const FIVE_HOUR_WARN = [50, 75, 90]

// Strip palette.
const LABEL = '#ece8df'
const MUTED = '#8c877d'
const GREEN = '#4cc764'
const YELLOW = '#e6b84a'
const RED = '#e5534b'
const WARM = '#7cbf6a'
const COLD = '#5b9bf0'
const HANDOFF = '#7fb8d6'
const BAR_CELLS = 10

// The prompt cache lives about an hour from the last request; it starts cooling at 45 min.
const CACHE_COOLING_MIN = 45
const CACHE_COLD_MIN = 60
// Below this a cold re-read is cheap, so the countdown stays blank.
const CACHE_STAKE_MIN_TOKENS = 50_000

const FIVE_HOUR_MS = 5 * 60 * 60_000
const WEEK_MS = 7 * 24 * 60 * 60_000

// A handoff skill may be installed bare (`handoff`) or namespaced by a plugin or synced account (`anthropic-skills:handoff`).
export const runHandoff = async ($: EngineInterface) => {
  const names = (await $.command.list()).map(c => c.name)
  const command = names.find(n => n === 'handoff') ?? names.find(n => n.endsWith(':handoff'))
  if (command) await $.command.run({ command })
  else $.ui.toast('No handoff skill or command installed.')
}

// `compactAt` is the window auto-compaction measures against (what the app's Context % uses), smaller than the model's.
const toUsage = (m: Pick<SessionMeasureInput, 'context' | 'rateLimits'>, compactAt?: number): Usage => {
  const five = m.rateLimits.find(r => r.kind === 'five_hour')
  const week = m.rateLimits.find(r => r.kind === 'seven_day')
  return {
    fiveHour: five?.percentUsed,
    fiveHourResetsAt: five?.resetsAt,
    week: week?.percentUsed,
    weekResetsAt: week?.resetsAt,
    contextPct: m.context.tokens !== undefined && compactAt ? Math.round((m.context.tokens / compactAt) * 100) : m.context.percent,
    contextTokens: m.context.tokens,
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

// `1:48` under a day, `3d 4h` beyond.
export function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}:${String(mins % 60).padStart(2, '0')}`
}

export type Plan = { pct: number; ahead: boolean; resetsAt?: string }

// One limit window; `ahead` when its usage outruns the share of the window gone by.
export function planUsage(pct: number | undefined, resetsAt: string | undefined, length: number, now: number): Plan | undefined {
  if (pct === undefined) return undefined
  let ahead = false
  if (resetsAt) {
    const elapsed = 1 - (Date.parse(resetsAt) - now) / length
    ahead = pct / 100 > Math.min(1, Math.max(0, elapsed))
  }
  return { pct: Math.round(pct), ahead, resetsAt }
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
      if (mins === CACHE_COOLING_MIN && tokens >= CACHE_STAKE_MIN_TOKENS) {
        $.ui.toast(`Cache cools in ${CACHE_COLD_MIN - mins} min. Stepping away? Press HANDOFF now while it's cheap.`)
      }
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await saveActivity($, await $.clock.now())
    return next(e)
  }).catch(($, e, next) => next(e))

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
        $.ui.toast(`Session context at ${Math.round(u.contextPct!)}%: every message re-reads it. Consider HANDOFF then /clear, or /compact.`)
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    const now = await $.clock.now()
    await read($, tick)
    const last = await read($, lastActivity)
    const { Box, Button, Text } = $.ui.resolve(e)

    // Every cell keeps its width and never wraps: the strip is one line, and clips at the right when too wide.
    const nb = (text: string) => text.replace(/ /g, '\u00a0')
    const cell = (key: string, child: RenderChildren) => (
      <Box key={key} flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>{child}</Box>
    )
    const sep = (key: string) => cell(key, <Text mono color={MUTED}>│</Text>)
    const cells: RenderChildren[] = []

    // Gradient bar: the context, green under 50%, yellow under 80%, then red.
    if (u.contextPct !== undefined) {
      const pct = Math.min(100, Math.max(0, Math.round(u.contextPct)))
      const filled = Math.round((pct / 100) * BAR_CELLS)
      const color = pct < 50 ? GREEN : pct < 80 ? YELLOW : RED
      cells.push(
        <Box key="ctx" flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
          <Text mono wrap="truncate">
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text color={MUTED}>{'░'.repeat(BAR_CELLS - filled)}</Text>
          </Text>
          <Text mono weight="bold" color={color} wrap="truncate">{pct}%</Text>
        </Box>,
      )
    }

    // The 5-hour window, then the 7-day one: percent used, time until it resets.
    const windows = [
      { key: '5h', plan: planUsage(u.fiveHour, u.fiveHourResetsAt, FIVE_HOUR_MS, now) },
      { key: '7d', plan: planUsage(u.week, u.weekResetsAt, WEEK_MS, now) },
    ]
    for (const { key, plan } of windows) {
      if (!plan) continue
      const reset = untilReset(plan.resetsAt, now)
      const color = plan.pct < 50 ? GREEN : plan.pct < 80 ? YELLOW : RED
      if (cells.length) cells.push(sep(`s-${key}`))
      cells.push(
        <Box key={key} flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
          <Text mono weight="bold" color={color} wrap="truncate">{`${plan.pct}%${plan.ahead ? '↑' : ''}`}</Text>
          {reset ? <Text mono color={LABEL} wrap="truncate">{nb(reset)}</Text> : null}
        </Box>,
      )
    }

    // Cache: Warm with the minutes left before it goes cold, then Cold.
    const mins = last === null ? undefined : Math.floor((now - last) / 60000)
    if (mins !== undefined) {
      const warm = mins < CACHE_COLD_MIN
      if (cells.length) cells.push(sep('s-cache'))
      cells.push(
        <Box key="cache" flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
          <Text mono weight="bold" color={warm ? WARM : COLD} wrap="truncate">{warm ? 'Warm' : 'Cold'}</Text>
          {warm ? <Text mono color={LABEL} wrap="truncate">{`${CACHE_COLD_MIN - mins}m`}</Text> : null}
        </Box>,
      )
    }

    if (cells.length) cells.push(sep('s-buttons'))
    cells.push(
      <Box key="buttons" flexDirection="row" alignItems="center" gap="md" flexShrink={0}>
        {/* Each runs its command, as typing it + Return would. */}
        <Button key="clear" label="CLEAR" onPress={() => void $.command.run({ command: 'clear' })}>
          <Text mono weight="bold" color={HANDOFF}>CLEAR</Text>
        </Button>
        <Button key="handoff" label="HANDOFF" onPress={() => void runHandoff($)}>
          <Text mono weight="bold" color={HANDOFF}>HANDOFF</Text>
        </Button>
      </Box>,
    )

    // Left to right, one line; clips at the right when too wide.
    return (
      <Box flexDirection="row" alignItems="center" gap="md" paddingX="md" paddingY={0} overflow="hidden">
        {cells}
      </Box>
    )
  })
}
