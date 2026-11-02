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
}

export type Report = { checkedAt: number; items: Item[] }

declare module 'claude-code' {
  interface PluginState {
    'skill-updates': {
      report: Shaped<Report | null>
      // 'check', 'all', or the id of the item being updated
      busy: string | null
      message: string | null
      // claude.ai skills whose zip is built, by id: the upstream commit it holds
      zips: Record<string, string>
      expanded: boolean
      // the folded line's count, lit or dim
      blink: boolean
    }
  }
}
