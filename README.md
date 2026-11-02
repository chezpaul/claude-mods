# claude-mods

Mods for Claude Code (terminal and the desktop app's Code tab).

| Mod | What it does |
| --- | --- |
| [usage-line](./usage-line) | Usage strip above the prompt: 5-hour and weekly limits, prompt-cache age (Warm / Cooling / Cold), and context use. Pops up a warning when a session's context or cost gets high. |
| [skill-updates](./skill-updates) | Sidebar pane listing skills and plugins that are behind their GitHub source, with an **Update all** button. |
| [handoff-before-cold](./handoff-before-cold) | Runs `/handoff` by itself at 59 idle minutes, just before the prompt cache goes cold, unless the last turn was already a handoff. |

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-line --marketplace chezpaul/claude-mods
/plugin install handoff-before-cold --marketplace chezpaul/claude-mods
/plugin install skill-updates --marketplace chezpaul/claude-mods
```

From a shell:

```bash
claude plugin install usage-line --marketplace chezpaul/claude-mods
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `chezpaul/claude-mods`, then **Add plugin**.

Answer `y` to add the marketplace, then pick the user scope so it loads in every session. Needs a recent Claude Code (2.1.308 or later).

## Updates

Updates don't arrive on their own: Claude Code leaves auto-update off for marketplaces outside Anthropic's own. To turn it on once, run `/plugin` in a terminal session, open the **Marketplaces** tab, pick `claude-mods`, and choose **Enable auto-update**. New versions then download in the background after your first message, and load the next time you start a session.

To update by hand instead:

```bash
claude plugin marketplace update claude-mods
```

```bash
claude plugin update usage-line
```

Then restart Claude Code.

## usage-line

```
USAGE   5H ●●●●●●···· 59%   7D ●●●●······ 38%   CACHE Warm · 3m   CTX ●●●······· 28%   HANDOFF
```

- **5H / 7D**: share of your 5-hour and weekly limits used.
- **HANDOFF** (right end): runs `/handoff`. Needs a `handoff` skill or command installed.
- **CACHE**: minutes since the last message. Warm under 45 min, Cooling to 60, Cold after: the prompt cache has likely expired, so the next message re-reads the whole chat at full price. Consider a fresh session.
- **CTX**: how full the context window is; every message re-reads it.
- **Cold-cache catcher**: at 45 min idle (chat over 50k tokens) it reminds you to `/handoff` while that's still cheap. Send a message once the cache is Cold and it asks first: *Send anyway* or *Start fresh instead* (drops the message so you can `/clear` and restate it; a handoff at that point would re-read the cold chat too).
- Warnings pop up once when context passes 40/60/80% and when the 5-hour limit passes 50/75/90% (again in each new 5-hour window).

In the desktop app it draws as a band above the prompt; in the terminal it adds the figures to the hint line under the prompt.

## handoff-before-cold

The prompt cache lasts an hour from the last message. 59 minutes after a turn ends with nothing new, this mod runs your `handoff` skill (bare `handoff` or namespaced, like `anthropic-skills:handoff`) while the cache is still warm, so the handoff is cheap.

- Skips it when the last turn was already a handoff, whether you typed `/handoff` or asked Claude to write one, and after `/clear`.
- A new message restarts the countdown. After an auto-handoff it doesn't fire again until you send something else.
- Only runs while the session is open and the Mac is awake. Each open idle session hands off on its own.

## skill-updates

A pane in the sidebar that compares every skill and plugin you added with its GitHub source, file by file, and lists the ones that are behind.

Folded, it takes one line, with the number of updates blinking at the right:

```
Skill updates ▸                              3
```

Click the line to unfold the full list (`/skill-updates` unfolds it too); click it again to fold it:

```
Skill updates ▾
3 updates · checked 2h ago                Refresh
[ Update all (3) ]
humanizer    claude.ai · 2.5.1 → 3.1.0    Build zip
swiftui-pro  skill · 1.1 → 2.0.0          Update
superpowers  plugin · 6.4.2 → 7.0.1       Update
9 up to date · not on GitHub: restore, thread-security
```

- **Skills in `~/.claude/skills`**: replaced with the GitHub copy. The old folder is kept in `~/.claude/skill-backups/`.
- **Skills you uploaded to claude.ai**: Claude Code can't upload, so the button builds the zip on your Desktop and shows it in Finder. Upload it on claude.ai to replace the old one; the pane stops listing it once the new version syncs.
- **Marketplace plugins**: runs `claude plugin update`. The new version loads in your next session.
- Anthropic's own skills update themselves and aren't listed.

It checks when a session starts (at most every 12 hours), and on **Refresh** or `/skill-updates`. GitHub repos come from `github.com` links in each skill's files; add any it can't find to `sources.json` (`"skill-name": "owner/repo"`, or `"none"` to stop checking one). Needs the GitHub CLI (`gh`) signed in, and Python 3.
