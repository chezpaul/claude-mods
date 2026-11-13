import { expect, test } from 'claude-code/testing'

import { planUsage, untilReset } from './register'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString()

test('reset reads h:mm under a day, days beyond', async () => {
  expect(untilReset(at(108), NOW)).toBe('1:48')
  expect(untilReset(at(3 * 1440 + 4 * 60), NOW)).toBe('3d 4h')
})

test('each window gives its percent, reset, and whether it runs ahead', async () => {
  // 5-hour: 73% used with 1:48 left, so 64% of the window has gone by: ahead.
  expect(planUsage(73, at(108), 5 * 60 * 60_000, NOW)).toEqual({ pct: 73, ahead: true, resetsAt: at(108) })
  // 7-day: 30% used with 1 day left (86% gone by): behind.
  expect(planUsage(30, at(1440), 7 * 24 * 60 * 60_000, NOW)).toEqual({ pct: 30, ahead: false, resetsAt: at(1440) })
  expect(planUsage(undefined, undefined, 1, NOW)).toBe(undefined)
})
