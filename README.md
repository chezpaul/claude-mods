# claude-mods

Mods for Claude Code (terminal and the desktop app's Code tab).

| Mod | What it does |
| --- | --- |
| [usage-line](./usage-line) | Usage strip above the prompt: 5-hour and weekly limits, prompt-cache age (Warm / Cooling / Cold), and context use. Pops up a warning when a session's context or cost gets high. |

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-line --marketplace chezpaul/claude-mods
```

From a shell:

```bash
claude plugin install usage-line --marketplace chezpaul/claude-mods
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `chezpaul/claude-mods`, then **Add plugin**.

Answer `y` to add the marketplace, then pick the user scope so it loads in every session. Needs a recent Claude Code (2.1.308 or later).

## usage-line

```
USAGE   5H ●●●●●●···· 59%   7D ●●●●······ 38%   CACHE Warm · 3m   CTX ●●●······· 28%   HANDOFF
```

- **5H / 7D**: share of your 5-hour and weekly limits used.
- **HANDOFF** (right end): runs `/handoff`. Needs a `handoff` skill or command installed.
- **CACHE**: minutes since the last message. Warm under 45 min, Cooling to 60, Cold after: the prompt cache has likely expired, so the next message re-reads the whole chat at full price. Consider a fresh session.
- **CTX**: how full the context window is; every message re-reads it.
- **Cold-cache catcher**: at 45 min idle (chat over 50k tokens) it reminds you to `/handoff` while that's still cheap (also pushed to your phone when the session has Remote Control on). Send a message once the cache is Cold and it asks first: *Send anyway* or *Start fresh instead* (drops the message so you can `/clear` and restate it; a handoff at that point would re-read the cold chat too).
- Warnings pop up once when context passes 40/60/80% and when the 5-hour limit passes 50/75/90% (again in each new 5-hour window).

In the desktop app it draws as a band above the prompt; in the terminal it adds the figures to the hint line under the prompt.
