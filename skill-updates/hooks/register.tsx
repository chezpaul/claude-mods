import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Report, Zip } from '../types'

const PANE = 'skill-updates'
const TITLE = 'Skill updates'
const STALE_MS = 12 * 60 * 60 * 1000
// While a zip waits for its upload, how often to look whether claude.ai has synced.
const SYNC_POLL_MS = 2 * 60 * 1000

// Change the tag when Report's fields change: it declines what an earlier
// version stored, which outlives a reload.
const report = atom({ plugin: 'skill-updates', key: 'report' } as const, null, { shape: 'report-1' })
const busy = atom({ plugin: 'skill-updates', key: 'busy' } as const, null)
const message = atom({ plugin: 'skill-updates', key: 'message' } as const, null)
const zips = atom({ plugin: 'skill-updates', key: 'zips' } as const, {}, { shape: 'zips-2' })
// Folded, the pane is one line; a press on it unfolds the full list.
const expanded = atom({ plugin: 'skill-updates', key: 'expanded' } as const, false)

const KIND_LABEL: Record<Item['kind'], string> = {
  personal: 'skill',
  claudeai: 'claude.ai',
  plugin: 'plugin',
}

async function script($: EngineInterface, args: string[], timeoutMs: number) {
  const ran = await $.process.run(['python3', '-I', `${$.plugin.root}/bin/skill_updates.py`, ...args], {
    timeoutMs,
  })
  try {
    return JSON.parse(ran.stdout)
  } catch {
    return { ok: false, message: (ran.stderr || ran.stdout || 'no output').trim().slice(0, 300) }
  }
}

async function check($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => 'check')
  try {
    const result = await script($, ['check'], 180_000)
    if (Array.isArray(result.items)) {
      await update($, report, () => result as Report)
      await $.store.set('report', result)
      // A zip that the sync has caught up with, or that an even newer commit
      // has overtaken, is no longer waiting for an upload.
      const byId = new Map((result as Report).items.map(i => [i.id, i]))
      const built = await read($, zips)
      const uploaded = Object.entries(built).filter(([id]) => byId.get(id)?.status === 'current')
      await update($, zips, now =>
        Object.fromEntries(
          Object.entries(now).filter(([id, z]) => byId.get(id)?.status === 'outdated' && byId.get(id)?.remoteSha === z.sha),
        ),
      )
      await $.store.set('zips', await read($, zips))
      // Uploaded: its zip has done its job.
      for (const [, z] of uploaded) if (z.zip) await script($, ['trash', z.zip], 30_000)
      if (uploaded.length > 0) {
        const names = uploaded.map(([id]) => byId.get(id)?.name ?? id).join(', ')
        $.ui.toast(`${names} uploaded to claude.ai · zip moved to the Trash`)
      }
    } else {
      await update($, message, () => `Check failed: ${result.message}`)
    }
  } finally {
    await update($, busy, () => null)
  }
}

async function updateOne($: EngineInterface, item: Item) {
  const result = await script($, ['update', item.id], 600_000)
  if (result.ok && result.zip && result.remoteSha) {
    await update($, zips, built => ({ ...built, [item.id]: { sha: result.remoteSha, zip: result.zip } }))
    await $.store.set('zips', await read($, zips))
  }
  return result.ok ? result.message : `${item.name}: ${result.message}`
}

async function updateItems($: EngineInterface, items: Item[], label: string) {
  if (await read($, busy)) return
  await update($, busy, () => label)
  const lines: string[] = []
  try {
    for (const item of items) lines.push(await updateOne($, item))
  } finally {
    await update($, busy, () => null)
  }
  await update($, message, () => lines.join('\n'))
  await check($)
}

// Checks again once the claude.ai skills have synced since the last check.
async function pollSync($: EngineInterface) {
  if ((await read($, busy)) || Object.keys(await read($, zips)).length === 0) return
  const synced = await script($, ['synced'], 30_000)
  const last = await read($, report)
  if (synced.ok && last && synced.lastUpdated > last.checkedAt) await check($)
}

function tokens(delta: number | null | undefined) {
  if (!delta) return ''
  return ` · ${delta > 0 ? '+' : '−'}${Math.abs(delta)} tok`
}

function ago(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'skill-updates',
      description: 'Open the Skill updates pane and check GitHub for newer versions',
    })
    const stored = (await $.store.get('report')) as Report | undefined
    if (stored && Array.isArray(stored.items)) await update($, report, () => stored)
    // Before zips-2 the store held only the commit, not the zip's path.
    const built = (await $.store.get('zips')) as Record<string, Zip | string> | undefined
    if (built) {
      const zipsNow = Object.fromEntries(
        Object.entries(built).map(([id, z]) => [id, typeof z === 'string' ? { sha: z, zip: '' } : z]),
      )
      await update($, zips, () => zipsNow)
    }
    void $.ui.open({ id: PANE, title: TITLE })
    const now = await $.clock.now()
    if (!stored || now - stored.checkedAt > STALE_MS) $.clock.after(5_000, () => void check($))
    $.clock.every(STALE_MS, () => void check($))
    $.clock.every(SYNC_POLL_MS, () => void pollSync($))
    return started
  })

  on('command.run', { command: 'skill-updates' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await update($, expanded, () => true)
    $.clock.after(0, () => void check($))
    return { text: 'Checking your skills and plugins for updates.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, report)
    const working = await read($, busy)
    const note = await read($, message)
    const built = await read($, zips)
    const now = Date.now()

    const outdated = data?.items.filter(i => i.status === 'outdated') ?? []
    const actionable = outdated.filter(i => !built[i.id])
    const waiting = outdated.filter(i => built[i.id])
    const errors = data?.items.filter(i => i.status === 'error') ?? []
    const current = data?.items.filter(i => i.status === 'current') ?? []
    const untracked = data?.items.filter(i => i.status === 'untracked') ?? []

    // Work runs on a timer of its own, so a long update never holds the press.
    const later = (fn: () => Promise<void>) => () => void $.clock.after(0, () => void fn())

    const summary = !data
      ? working ? 'Checking GitHub…' : 'Not checked yet'
      : `${actionable.length === 0 ? 'All up to date' : `${actionable.length} update${actionable.length === 1 ? '' : 's'}`} · checked ${ago(now - data.checkedAt)}`

    const isOpen = await read($, expanded)
    const toggle = () => void update($, expanded, open => !open)
    const label = actionable.length === 1 ? 'Skill update' : 'Skill updates'

    if (!isOpen) {
      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Button key="toggle" plain onPress={toggle}>
            {label} <Text dimColor>▸</Text>
          </Button>
          {working ? (
            <Text dimColor>…</Text>
          ) : actionable.length > 0 ? (
            <Button key="count" variant="primary" onPress={toggle}>
              {String(actionable.length)}
            </Button>
          ) : (
            <Text dimColor>✓</Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Button key="toggle" plain onPress={toggle}>
          {label} <Text dimColor>▾</Text>
        </Button>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{working === 'check' ? 'Checking GitHub…' : summary}</Text>
          <Button key="refresh" plain dimColor onPress={later(() => check($))}>
            Refresh
          </Button>
        </Box>

        {actionable.length > 0 && (
          <Button
            key="all"
            variant="primary"
            onPress={later(() => updateItems($, actionable, 'all'))}
          >
            {working === 'all' ? 'Updating…' : `Update all (${actionable.length})`}
          </Button>
        )}

        {actionable.length > 0 && (
          <Box flexDirection="column">
            {actionable.map(item => (
              <Box key={`row:${item.id}`} flexDirection="row" justifyContent="space-between">
                <Box flexDirection="column">
                  <Text>
                    {item.name}{' '}
                    <Text dimColor>
                      {KIND_LABEL[item.kind]}
                      {item.localVersion && item.remoteVersion && item.localVersion !== item.remoteVersion
                        ? ` · ${item.localVersion} → ${item.remoteVersion}`
                        : item.remoteVersion ? ` · → ${item.remoteVersion}` : ' · newer on GitHub'}
                      {tokens(item.tokenDelta)}
                    </Text>
                  </Text>
                  {/* Where the new copy comes from, before anything is replaced. */}
                  {item.repo && <Text dimColor>  from github.com/{item.repo}</Text>}
                </Box>
                <Button key={`u:${item.id}`} plain onPress={later(() => updateItems($, [item], item.id))}>
                  {working === item.id ? 'Updating…' : item.kind === 'claudeai' ? 'Build zip' : 'Update'}
                </Button>
              </Box>
            ))}
          </Box>
        )}

        {waiting.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Zip on your Desktop, upload on claude.ai:</Text>
            {waiting.map(item => (
              <Text key={`w:${item.id}`}>  {item.name}</Text>
            ))}
          </Box>
        )}

        {outdated.some(i => i.kind === 'plugin') && (
          <Text dimColor>Plugin updates apply in your next session.</Text>
        )}

        {errors.length > 0 && (
          <Box flexDirection="column">
            <Text color="yellow">Couldn't check:</Text>
            {errors.map(item => (
              <Text key={`e:${item.id}`} dimColor>
                {'  '}{item.name}: {item.note}
              </Text>
            ))}
          </Box>
        )}

        {note && <Text dimColor>{note}</Text>}

        {data && (
          <Text dimColor>
            {current.length} up to date
            {untracked.length > 0 && ` · not on GitHub: ${untracked.map(i => i.name).join(', ')}`}
          </Text>
        )}
      </Box>
    )
  })
}
