# Cockpit

[Français](README.md) · **English**

A live pane that shows what Claude is doing: the commands it runs and their output, the files it changes with their diffs, its subagents (including the agents of ultracode workflows), and the screen of a simulator, an emulator or the browser.

Cockpit only watches. It never blocks or changes a tool call. If something breaks on its side, the error is swallowed and the session carries on.

## Opening it

- **Desktop app (Code tab)**: the pane opens by itself as a sidebar, once per session, as soon as the app connects. To turn that off, disable the plugin's `autoOpen` option.
- **Anywhere**: the `/cockpit [tab]` command opens the pane, or focuses it if it is already open.
  - `/cockpit feed`, `files`, `agents` or `screen` opens the pane on that tab.
  - `/cockpit live` turns live screen capture on or off.
  - `/cockpit close` closes the pane.

## Header

A row of chips sums up the session: tool calls, commands, files touched, `+`/`−` lines, running and finished agents, errors, a streak of successful calls, and the session's duration. A small sparkline shows the last 6 minutes of activity. A few milestones raise a toast: first file changed, tests passing, 100 calls, 10 agents… A one-line summary also shows below the prompt.

## Tabs (keys 1 to 4)

| Key | Tab | What it shows |
|---|---|---|
| `1` | **Feed** | Every tool call, newest first. Each has a colored chip for its category (shell, edit, read, search, web, agent, screen, MCP), a status (◐ running, ✓ ok, ✗ error, ⛔ denied) and its duration. Click a row to see the full input, the output and the diff. A filter picks everything, the main session, or a single agent. |
| `2` | **Files** | The files changed, with `+`/`−` counts and each file's history as colored unified diffs. |
| `3` | **Agents** | The main session, then the tree of subagents and teammates. Workflow (ultracode) runs get a progress bar. What is running is listed first. A finished run folds into one line that expands with a click. Click an agent to see its own mini-feed and its answer. |
| `4` | **Screen** | The latest frame from a simulator, an emulator or a tool. `l` turns Live mode on or off (one capture every 2 s), `s` takes one capture. |

## Screen sources

| Source | What it needs |
|---|---|
| iOS Simulator | Xcode and its command-line tools (`xcrun simctl`), and a booted simulator. Frames are shrunk with `sips`, which ships with macOS. |
| Android emulator | `adb` on the `PATH`, in `~/Library/Android/sdk/platform-tools` or in `$ANDROID_HOME/platform-tools`, and a connected device (`adb devices`). |
| Tool screenshots | Nothing to install. Screenshots Claude takes with the browser tools (Claude Browser, Claude in Chrome), the iOS Simulator tool or computer use show up by themselves. |

Capture only runs while the Screen tab is visible and Live mode is on, or when you press Capture. In the desktop app the frame is drawn as an SVG holding a compressed JPEG. In the terminal it uses the kitty graphics protocol (kitty, Ghostty); elsewhere a text stands in for it.

## Installation

In a Claude Code session started in a terminal:

```
/plugin install cockpit --marketplace mderiano/claude-cockpit
```

Answer `y` to add the marketplace, then pick the "user" scope to get it in every session (terminal and desktop app).

Or from the command line:

```sh
claude plugin marketplace add mderiano/claude-cockpit
claude plugin install cockpit@claude-cockpit --scope user
```

It needs Claude Code 2.1.295 or later (`claude update`): the plugin uses `session.append` and `session.attach`.

### Development

```sh
claude --plugin-dir /path/to/claude-cockpit   # load the folder for one session
claude plugin validate /path/to/claude-cockpit
claude plugin test /path/to/claude-cockpit
```

## Limits

Cockpit keeps 300 calls, 200 files (12 changes per file), 150 agents and 20 workflow runs. Outputs are cut at about 4,000 characters and diffs at 12,000. Only one screen frame is kept: each new one replaces the last. `/clear` resets everything except the selected tab.
