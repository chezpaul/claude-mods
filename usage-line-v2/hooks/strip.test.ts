import { expect, test } from 'claude-code/testing'

import { planUsage, untilReset } from './register'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString()

test('reset reads h:mm under a day, days beyond', async () => {
  expect(untilReset(at(108), NOW)).toBe('1:48')
  expect(untilReset(at(3 * 1440 + 4 * 60), NOW)).toBe('3d 4h')
})

test('plan usage is the 5-hour window and flags running ahead', async () => {
  // 73% used with 1:48 left, so 64% of the window has gone by: ahead.
  const p = planUsage({ fiveHour: 73, fiveHourResetsAt: at(108), week: 40, weekResetsAt: at(3 * 1440) }, NOW)
  expect(p).toEqual({ pct: 73, ahead: true, resetsAt: at(108) })
  // Still the 5-hour window when the week is higher: 10% used with 1:00 left (80% gone by): behind.
  const q = planUsage({ fiveHour: 10, fiveHourResetsAt: at(60), week: 54, weekResetsAt: at(1440) }, NOW)
  expect(q).toEqual({ pct: 10, ahead: false, resetsAt: at(60) })
  expect(planUsage({ week: 54 }, NOW)).toBe(undefined)
})
