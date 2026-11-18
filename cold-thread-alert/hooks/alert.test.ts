import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { lastTitle } from './register'

const URL = 'https://ha.example/api/webhook/abc'
const prompt = (text: string, command?: { name: string; args: string }) =>
  ({ text, command, wait: true, origin: { kind: 'composer' as const } })
const turnEnd = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })

const setup = (on: On, posts: string[]) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  mock.env(on, { COLD_THREAD_WEBHOOK: URL })
  on('ui.toast', (_, e) => (posts.push(`toast ${e.text}`), { value: undefined }))
  on('http.fetch', (_, e) => (
    posts.push(`${e.url} ${e.init?.body}`),
    { value: { status: 200, ok: true, headers: {}, text: '' } }
  ))
}

test('the newest transcript title wins, escapes undone', async () => {
  const text = '{"type":"custom-title","customTitle":"Old"}\n{"type":"custom-title","customTitle":"Winter \\"heat\\""}\n'
  expect(lastTitle(text)).toBe('Winter "heat"')
  expect(lastTitle('{"type":"user"}')).toBe(undefined)
})

test('55 idle minutes after a turn, it posts once', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)

  await $.prompt.submit(prompt('fix it'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(54 * 60_000)
  expect(posts).toEqual([])
  await clock.advance(60_000)
  expect(posts.length).toBe(1)
  const sent = posts[0] ?? ''
  expect(sent.startsWith(`${URL} `)).toBe(true)
  expect(JSON.parse(sent.slice(URL.length + 1)).idle_minutes).toBe(55)
  await clock.advance(120 * 60_000)
  expect(posts.length).toBe(1)
})

test('a new prompt restarts the countdown', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  await $.prompt.submit(prompt('one'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(50 * 60_000)
  await $.prompt.submit(prompt('two'))
  await $.turn.complete(turnEnd('t2'))
  await clock.advance(50 * 60_000)
  expect(posts).toEqual([])
  await clock.advance(5 * 60_000)
  expect(posts.length).toBe(1)
})

test('no alert after a handoff turn', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  setup(on, posts)
  await $.prompt.submit(prompt('/handoff', { name: 'anthropic-skills:handoff', args: '' }))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(70 * 60_000)
  expect(posts).toEqual([])
})

test('no webhook set: a toast, no request', async ($, on) => {
  const clock = mock.clock(on)
  const posts: string[] = []
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  mock.env(on, {})
  on('ui.toast', (_, e) => (posts.push(`toast ${e.text}`), { value: undefined }))
  await $.prompt.submit(prompt('x'))
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(55 * 60_000)
  expect(posts).toEqual(['toast cold-thread-alert: set COLD_THREAD_WEBHOOK in settings.json env.'])
})
