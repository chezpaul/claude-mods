# claude-mods

Mods for Claude Code (terminal and the desktop app's Code tab).

| Mod | What it does |
| --- | --- |
| [usage-line](./usage-line) | Usage strip above the prompt: 5-hour and weekly limits, prompt-cache age (Warm / Cooling / Cold), and context use. Pops up a warning when a session's context or cost gets high. |
| [usage-line-v2](./usage-line-v2) | One-line strip above the prompt: context bar, 5-hour and 7-day usage with pace and reset time, cache state with minutes left, and **CLEAR** and **HANDOFF** buttons. |
| [skill-updates](./skill-updates) | Sidebar pane listing skills and plugins that are behind their GitHub source, with an **Update all** button. |
| [handoff-before-cold](./handoff-before-cold) | Runs `/handoff` by itself at 59 idle minutes, just before the prompt cache goes cold, unless the last turn was already a handoff. |
| [cold-thread-alert](./cold-thread-alert) | At 55 idle minutes, POSTs the thread's title to a webhook (for example Home Assistant, to announce it on a speaker) so you can get back before the prompt cache goes cold. |

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-line --marketplace chezpaul/claude-mods
/plugin install usage-line-v2 --marketplace chezpaul/claude-mods
/plugin install handoff-before-cold --marketplace chezpaul/claude-mods
/plugin install skill-updates --marketplace chezpaul/claude-mods
/plugin install cold-thread-alert --marketplace chezpaul/claude-mods
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

## usage-line-v2

```
████░░░░░░ 42% │ 73%↑ 1:48 │ 54% 3d 15h │ Warm 48m │ CLEAR HANDOFF
```

- **Context bar**: green under 50%, yellow under 80%, then red. Every message re-reads it.
- **5-hour, then 7-day limit**: percent of each window used, `↑` when usage runs ahead of the clock, then the time until it resets.
- **Warm / Cold**: the prompt cache. Warm shows the minutes left before it goes cold (an hour after the last message); after that the next message re-reads the whole chat at full price.
- **CLEAR**: runs `/clear`.
- **HANDOFF**: runs `/handoff`. Needs a `handoff` skill or command installed.
- Same warnings as usage-line: context at 40/60/80%, 5-hour limit at 50/75/90%, and a reminder at 45 idle minutes in a big chat.

Draws as a band above the prompt in the terminal and the desktop app. Don't run it beside usage-line, or you get two bands.

## usage-line

```
USAGE   5H ●●●●●●···· 59%   7D ●●●●······ 38%   CACHE Warm · 3m   CTX ●●●······· 28%   HANDOFF
```

- **5H / 7D**: share of your 5-hour and weekly limits used.
- **HANDOFF** (right end): runs `/handoff`. Needs a `handoff` skill or command installed.
- **CACHE**: minutes since the last message. Warm under 45 min, Cooling to 60, Cold after: the prompt cache has likely expired, so the next message re-reads the whole chat at full price. Consider a fresh session.
- **CTX**: how full the context window is; every message re-reads it.
- **Cold-cache catcher**: at 45 min idle (chat over 50k tokens) it reminds you to `/handoff` while that's still cheap.
- Warnings pop up once when context passes 40/60/80% and when the 5-hour limit passes 50/75/90% (again in each new 5-hour window).

In the desktop app it draws as a band above the prompt; in the terminal it adds the figures to the hint line under the prompt.

## handoff-before-cold

The prompt cache lasts an hour from the last message. 59 minutes after a turn ends with nothing new, this mod runs your `handoff` skill (bare `handoff` or namespaced, like `anthropic-skills:handoff`) while the cache is still warm, so the handoff is cheap.

- Skips it when the last turn was already a handoff, whether you typed `/handoff` or asked Claude to write one, and after `/clear`.
- A new message restarts the countdown. After an auto-handoff it doesn't fire again until you send something else.
- Only runs while the session is open and the Mac is awake. Each open idle session hands off on its own.

## cold-thread-alert

The prompt cache lasts an hour from the last message. 55 minutes after a turn ends with nothing new, this mod sends a POST to a webhook so something outside Claude can tell you a thread is about to go cold.

Set the webhook in `~/.claude/settings.json`:

```json
{ "env": { "COLD_THREAD_WEBHOOK": "https://your-home-assistant:8123/api/webhook/<random id>" } }
```

Optional: `COLD_THREAD_MINUTES` (1 to 59, default 55).

The body is JSON: `thread` (the session's title, else the project folder's name), `project`, `idle_minutes` and `session_id`.

- Skips it when the last turn was a handoff (the thread is saved) and after `/clear`. Pairs with handoff-before-cold, which hands off at 59 minutes.
- A new message restarts the countdown. One alert per idle stretch.
- Skips it while your 5-hour or weekly usage limit is reached, until that window resets: every thread stops at once then, and a warm cache is no use until the reset. One thread hitting the limit silences the others too.
- Only runs while the session is open and the Mac is awake.
- Treat the webhook id like a password: anyone who has it can trigger the alert.

A Home Assistant automation that chimes and announces it:

```yaml
- alias: Claude thread about to go cold
  mode: queued
  triggers:
    - trigger: webhook
      webhook_id: !secret claude_cold_webhook
      allowed_methods: [POST]
      local_only: false
  actions:
    - action: chime_tts.say
      target:
        entity_id: media_player.your_speaker
      data:
        chime_path: marimba
        message: "The Claude thread {{ trigger.json.thread }} is about to go cold."
```

## skill-updates

A pane in the sidebar that compares every skill and plugin you added with its GitHub source, file by file, and lists the ones that are behind.

Folded, it takes one line, with the number of updates as a button at the right:

```
Skill updates ▸                          [ 3 ]
```

Click the line to unfold the full list (`/skill-updates` unfolds it too); click it again to fold it:

```
Skill updates ▾
3 updates · checked 2h ago                Refresh
[ Update all (3) ]
humanizer    claude.ai · 2.5.1 → 3.1.0 · +12 tok    Build zip
swiftui-pro  skill · 1.1 → 2.0.0 · −30 tok         Update
superpowers  plugin · 6.4.2 → 7.0.1 · +85 tok      Update
9 up to date · not on GitHub: restore, thread-security
```

- **Skills in `~/.claude/skills`**: replaced with the GitHub copy. The old folder is kept in `~/.claude/skill-backups/`.
- **Skills you uploaded to claude.ai**: Claude Code can't upload, so the button builds the zip on your Desktop and shows it in Finder. Upload it on claude.ai to replace the old one. Once the new version syncs to this Mac (the pane looks every 2 minutes while a zip waits), the pane stops listing it and moves the zip to the Trash.
- **Marketplace plugins**: runs `claude plugin update`. The new version loads in your next session.
- Anthropic's own skills update themselves and aren't listed.
- **`+12 tok`** is roughly how many more tokens (or, with `−`, fewer) every message will carry after the update: the skill listing's name and description, and for a plugin the listings of all its skills, agents and commands. It's an estimate at about 4 characters a token, and leaves out MCP tools and hooks. A disabled plugin shows none.

It checks GitHub at most once every 12 hours, shared across all your threads, and any time on **Refresh** or `/skill-updates`. The pane pops up once per new update, not in every new thread; `/skill-updates` opens it whenever you want it. GitHub repos come from `github.com` links in each skill's files; add any it can't find to `sources.json` (`"skill-name": "owner/repo"`, or `"none"` to stop checking one). Needs the GitHub CLI (`gh`) signed in, and Python 3.
