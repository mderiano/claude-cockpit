# Cockpit

[Français](README.md) · **English**

A live pane that shows what Claude is doing: the commands it runs and their output, the files it changes with their diffs, its subagents (including the agents of ultracode workflows), and the screen of a simulator, an emulator or the browser.

Cockpit only watches. It never blocks or changes a tool call. If something breaks on its side, the error is swallowed and the session carries on.

## Opening it

- **Button above the prompt**: while the pane is closed, a `◆ Open Cockpit · 198` button reopens it in one click.
- **Button at the bottom right**, beside the mode labels: `◆ 198 · 2 agents` (tool calls, running agents). One click opens or closes the pane.
- **Desktop app**: the pane opens by itself as a sidebar, once per session. To turn that off, disable the plugin's `autoOpen` option.
- **Command**: `/cockpit` opens the pane, `/cockpit close` closes it, `/cockpit live [on|off]` sets continuous screen capture.

## What you see (desktop app)

One view, no tabs, as if you were looking over Claude's shoulder.

- **Header**: tool calls, commands, files changed (`+`/`−`), running agents, errors, session time, and a curve of the last 6 minutes of activity.
- **NOW**, what Claude is doing right now, drawn large:
  - a **command** in a terminal window: the command, a cursor while it runs, then the end of its output;
  - a **file change** with its colored diff (a subagent's too);
  - an **agent** or a **workflow** started: its state, what it is doing this moment, a progress bar with one segment per agent;
  - the **screen** of the browser or the simulator, refreshed after each action.
  
  When nothing runs, the last action stays in view.
- **HISTORY**, below: files and agents keep their card; commands, reads and searches fold into compact runs. Hover a line to see its output.

In the terminal, the pane keeps a tabbed view (Feed, Files, Agents, Screen; keys 1 to 4).

## Screen sources

| Source | What it needs |
|---|---|
| Built-in browser (Claude Browser) | Nothing. After each action, Cockpit takes a screenshot, when the app allows it without asking you. |
| Claude in Chrome | Nothing. A screenshot follows an action that names its tab. |
| iOS Simulator | Xcode (`xcrun simctl`) and a booted simulator. A screenshot follows each simulator action. Frames are shrunk with `sips`, which ships with macOS. |
| Android emulator | `adb` on the `PATH`, in `~/Library/Android/sdk/platform-tools` or in `$ANDROID_HOME/platform-tools`, and a connected device. |

The "Live screen" button captures the simulator or emulator every 2 s; "Capture screen" takes one frame. In the desktop app the frame is drawn as an SVG; in the terminal through the kitty graphics protocol (kitty, Ghostty).

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
