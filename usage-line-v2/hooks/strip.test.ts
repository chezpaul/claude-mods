import { expect, test } from 'claude-code/testing'

import { modelLabel, planUsage, untilReset } from './register'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString()

test('model ids read as family and version', async () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('Opus 5.5')).toBe('Opus 5.5')
})

test('reset reads h:mm under a day, days beyond', async () => {
  expect(untilReset(at(108), NOW)).toBe('1:48')
  expect(untilReset(at(3 * 1440 + 4 * 60), NOW)).toBe('3d 4h')
})

test('plan usage takes the window closest to its limit and flags running ahead', async () => {
  // 5h window: 73% used with 1:48 left, so 64% of the window has gone by: ahead.
  const p = planUsage({ fiveHour: 73, fiveHourResetsAt: at(108), week: 40, weekResetsAt: at(3 * 1440) }, NOW)
  expect(p).toEqual({ pct: 73, ahead: true, resetsAt: at(108) })
  // Week window: 30% used with 1 day left (86% gone by): behind.
  const q = planUsage({ fiveHour: 10, fiveHourResetsAt: at(60), week: 30, weekResetsAt: at(1440) }, NOW)
  expect(q).toEqual({ pct: 30, ahead: false, resetsAt: at(1440) })
  expect(planUsage({}, NOW)).toBe(undefined)
})
