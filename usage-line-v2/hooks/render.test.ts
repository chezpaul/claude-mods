import { expect, mock, test } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 } } as never
const USAGE = { startedAt: 0, context: { tokens: 120_000, window: 1_000_000, percent: 12, breakdown: { rawMaxTokens: 400_000 } }, rateLimits: [] } as never

test('a reopened thread draws every cell from stored limits and activity', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { limits: { fiveHour: 7, week: 44 }, lastActivity: { s1: 0 } })
  await clock.advance(10 * 60_000)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: '/Users/me/Claude-Projects/questions' }))
  on('session.usage', () => ({ value: USAGE }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-line-v2', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  for (const text of ['Opus\u00a05.5', '30%', '⧗\u00a050\u00a0min', '44%', 'Warm']) expect(await ui.find({ type: 'Text', text })).toBeTruthy()
  await ui.unmount()
})
