export type Usage = {
  fiveHour?: number
  fiveHourResetsAt?: string
  week?: number
  weekResetsAt?: string
  contextPct?: number
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-line': { usage: Usage; lastActivity: number | null; tick: number }
  }
}
