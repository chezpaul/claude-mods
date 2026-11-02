import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'skill-updates',
  component: 'Pane',
  requestId: 'skill-updates',
  props: {
    title: 'Skill updates',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPORT: import('../types').Report = {
  checkedAt: Date.now(),
  items: [
    { id: 'claudeai:humanizer', kind: 'claudeai', name: 'humanizer', status: 'outdated', localVersion: '2.5.1', remoteVersion: '3.1.0', remoteSha: 'abc' },
    { id: 'personal:swiftui-pro', kind: 'personal', name: 'swiftui-pro', status: 'outdated', localVersion: '1.1', remoteVersion: '2.0.0', remoteSha: 'def', tokenDelta: 42 },
    { id: 'plugin:code-review@claude-plugins-official', kind: 'plugin', name: 'code-review', status: 'current' },
    { id: 'personal:restore', kind: 'personal', name: 'restore', status: 'untracked', note: 'no GitHub source' },
  ],
}

// What the mod stored before the pane draws: report under its shape tag.
function seed(on: any, values: Record<string, unknown>) {
  on('state.get', (_: unknown, e: { key: string }, next: (e: unknown) => unknown) =>
    e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e),
  )
}

test('the pane lists what is behind GitHub, on every surface', async ($, on) => {
  seed(on, { report: { shape: 'report-1', value: REPORT }, expanded: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'all' }))?.text).toContain('Update all (2)')
    expect((await ui.find({ type: 'Button', key: 'u:claudeai:humanizer' }))?.text).toContain('Build zip')
    expect((await ui.find({ type: 'Button', key: 'u:personal:swiftui-pro' }))?.text).toContain('Update')
    expect((await ui.find({ type: 'Text', text: /2\.5\.1 → 3\.1\.0/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /\+42 tok/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /not on GitHub: restore/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('a built zip waits for its upload instead of offering the button again', async ($, on) => {
  seed(on, { report: { shape: 'report-1', value: REPORT }, zips: { shape: 'zips-2', value: { 'claudeai:humanizer': { sha: 'abc', zip: '/Users/x/Desktop/humanizer-3.1.0.zip' } } }, expanded: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'u:claudeai:humanizer' })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'all' }))?.text).toContain('Update all (1)')
  expect(await ui.find({ type: 'Text', text: /upload on claude\.ai/ })).toBeTruthy()
  await ui.unmount()
})

test('before the first check the pane says so', async ($, on) => {
  seed(on, { expanded: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Not checked yet/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'all' })).toBeFalsy()
  await ui.unmount()
})

test('folded, the pane is one line with the count to press', async ($, on) => {
  seed(on, { report: { shape: 'report-1', value: REPORT } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.text).toContain('Skill updates')
    expect((await ui.find({ type: 'Button', key: 'count' }))?.text).toBe('2')
    expect(await ui.find({ type: 'Button', key: 'all' })).toBeFalsy()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Button', key: 'all' })).toBeTruthy()
    // Fold it again: the state is shared by the next surface's pass.
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})
