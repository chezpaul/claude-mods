export type Usage = {
  fiveHour?: number
  fiveHourResetsAt?: string
  week?: number
  weekResetsAt?: string
  contextPct?: number
  contextTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-line-v2': { usage: Usage; lastActivity: number | null; tick: number }
  }
}
