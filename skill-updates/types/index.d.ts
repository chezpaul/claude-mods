export type Item = {
  id: string
  kind: 'personal' | 'claudeai' | 'plugin'
  name: string
  status: 'outdated' | 'current' | 'untracked' | 'error'
  localVersion?: string | null
  remoteVersion?: string | null
  remoteSha?: string
  repo?: string
  note?: string
  // Rough tokens the update adds to (or, negative, takes off) every message's listing
  tokenDelta?: number | null
}

// A claude.ai zip on the Desktop: the upstream commit it holds and where it is
export type Zip = { sha: string; zip: string }

export type Report = { checkedAt: number; items: Item[] }

declare module 'claude-code' {
  interface PluginState {
    'skill-updates': {
      report: Shaped<Report | null>
      // 'check', 'all', or the id of the item being updated
      busy: string | null
      message: string | null
      // claude.ai skills whose zip is built, by id
      zips: Shaped<Record<string, Zip>>
      expanded: boolean
    }
  }
}
