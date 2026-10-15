# Cockpit

[Français](README.md) · **English**

A live pane that shows what Claude is doing: the commands it runs and their output, the files it changes with their diffs, its subagents (including the agents of ultracode workflows), and the screen of whatever app Claude drives: a browser, a simulator, an emulator, Blender, Godot, Unity, Unreal, FreeCAD, OpenSCAD, KiCad, or any app you name.

Cockpit only watches. It never blocks or changes a tool call. If something breaks on its side, the error is swallowed and the session carries on.

## Opening it

- **Button above the prompt**: while the pane is closed, a `◆ Open Cockpit · 198` button reopens it in one click.
- **Button at the bottom right**, beside the mode labels: `◆ 198 · 2 agents` (tool calls, running agents). One click opens or closes the pane.
- **Desktop app**: the pane opens by itself as a sidebar, once per session. To turn that off, disable the plugin's `autoOpen` option.
- **Command**: `/cockpit` opens the pane, `/cockpit close` closes it, `/cockpit live [on|off]` sets continuous screen capture (it stays on until you turn it off), `/cockpit watch <App>` follows an app's window (macOS), `/cockpit watch off` stops.

## What you see (desktop app)

One view, no tabs, as if you were looking over Claude's shoulder.

- **Header**: tool calls, commands, files changed (`+`/`−`), running agents, errors, session time, and a curve of the last 6 minutes of activity. Right under it, always there, the **Live screen** and **Capture screen** buttons.
- **NOW**, only while something is happening; when nothing is, the section is not drawn at all:
  - a **command** running, in a terminal window: the command and a cursor;
  - any other **call** running (a fetch, an MCP tool, a file being edited), drawn large;
  - a **subagent** at work: its card, then its calls as lines (the running one first, then its latest five), the command it runs in a terminal and the file it just changed with its diff;
  - a **workflow** run: its state, a progress bar with one segment per agent, and its two busiest agents shown like subagents;
  - the **screens**: each simulator and emulator while Live is on, the window you watch, and a picture a call just made (a browser screenshot, a `Read` of a PNG, an image a command wrote) while Claude's turn goes on. Several at once are shown together, two phones side by side when the pane is wide enough. Each says above it where it comes from (`iPhone 17 Pro · Live`, `OpenSCAD · out/preview.png · just now`, `Krita · untitled.kra · Watching`).

  A call that works with a known app carries that app's badge (its colour and name), and an app's command is titled by what it does: `Blender · Render`, `Godot · Export`, `OpenSCAD · Render`. A binary asset a command or a Write changed (`.blend`, `.FCStd`, `.uasset`, `.umap`, `.stl`, `.glb`...) gets an "Asset changed" card with its size instead of a diff.
- **HISTORY**, below: what just ended goes straight to the top. The main loop's last command keeps its terminal with the end of its output; a file change keeps its diff (20 lines for the newest, 10 for the next two, then the file's head alone); agents and workflow runs keep their card; other commands, reads and searches fold into compact runs: a summary line, then their newest three calls as lines. A screen that is no longer happening shows as a smaller card just above the call that made it.

### Click to unfold

Everything cut short opens with a click, and closes the same way:

- **`+ N more`** under a run shows all its calls (**Show less** folds them back);
- **a call's line** shows, under it, what it was (tool, state, time, exit code, agent), its whole command (or its input) and its whole output;
- **Show full command and output** under a terminal (or **Show input and output** under another call's card, **Show prompt and answer** under an agent's) shows the same under the card;
- **Show N more lines** under a diff shows it whole (**Show less** folds it).

What you unfolded stays unfolded as the view updates (40 things at most), until `/clear`.

The view is made of still images and native lines: nothing in it reloads unless what it shows changed, and times move each second only while something runs (ages change once a minute).

In the terminal, the pane keeps a tabbed view (Feed, Files, Agents, Screen; keys 1 to 4).

## Screen sources

| Source | What it needs |
|---|---|
| Built-in browser (Claude Browser) | Nothing. After each action, Cockpit takes a screenshot, when the app allows it without asking you. |
| Claude in Chrome | Nothing. A screenshot follows an action that names its tab. |
| iOS Simulator | Xcode (`xcrun simctl`) and a booted simulator. A screenshot follows each simulator action. Frames are shrunk with `sips`, which ships with macOS. |
| Android emulator | `adb` on the `PATH`, in `~/Library/Android/sdk/platform-tools` or in `$ANDROID_HOME/platform-tools`, and a connected device. |
| Any image in a tool's result | Nothing. Whatever the tool (a `Read` of a PNG, an MCP tool that renders or captures), the image Claude sees shows on the screen. |
| An image a command wrote | Nothing. After a command ends, the image files it names (`openscad -o out/preview.png`, `--output=shot.jpg`, `> plot.png`) that it wrote are looked up; the newest shows. Patterns such as Blender's `render_####.png` are skipped. |
| An app's MCP screenshot tool | Nothing. After an action on an app's MCP server (blender-mcp, a Godot or Unity server...) whose result holds no image, Cockpit calls that server's screenshot tool (`get_viewport_screenshot`, or a tool named like `screenshot` / `capture_viewport`), only when the app allows that call without asking you. |
| An app's window (macOS) | `/cockpit watch <App>`, or `"window"` set on an app of your `cockpit.json`, and the **Screen Recording** permission for Claude (System Settings › Privacy & Security › Screen Recording). Only that app's frontmost window is captured (`screencapture -l <window id>`), never the whole screen. |

### Live screen

The **Live screen** button (or `/cockpit live on`) captures every booted simulator (iOS, watchOS, visionOS; four at most) and every connected Android device (four at most, six devices in all) every 2 s, each in its own frame, side by side. Live stays on until you turn it off (the button, `/cockpit live off`):

- no simulator or emulator yet: it keeps looking (after 2 s, then 5 s, then every 10 s) and NOW says "Live screen — waiting for a simulator or emulator…"; the first one booted shows by itself;
- a device shut down or unplugged: its frame goes, the others stay;
- a capture that fails: the reason shows under the buttons and Live looks again later.

**Capture screen** takes one frame of each device (or of the watched window), shown under NOW for a minute. After a simulator action of Claude's, the simulator is captured too. In the desktop app the frames are drawn as SVG; in the terminal through the kitty graphics protocol (kitty, Ghostty), the first device on the Screen tab.

### Watching an app's window

`/cockpit watch Blender` captures Blender's largest on-screen window every 2 s while the pane is shown, and backs off (up to 30 s) while the window cannot be found. The name is the app's name as macOS shows it (Finder, Blender, Godot, Unity, krita). Apps of your `cockpit.json` with a `"window"` are captured once after Claude works with them, without a watch.

Window capture needs the Screen Recording permission. Without it, the screen says "Window capture needs Screen Recording permission for Claude (System Settings › Privacy & Security › Screen Recording)" and the watch stops; grant it, restart the app, and run `/cockpit watch <App>` again.

## Apps

Cockpit knows Unity, Unreal Engine, Godot, Blender, FreeCAD, OpenSCAD, KiCad, the browsers (Claude Browser, Claude in Chrome, Playwright), the iOS Simulator and Android. A call is recognised by its MCP server (`mcp__blender__...`), its command (`blender -b ...`, `godot --export-release`, `Unity -batchmode`, `UnrealEditor-Cmd`, `openscad`, `freecadcmd`, `kicad-cli`, `xcrun simctl`, `adb`) or its file's extension (`.blend`, `.tscn`, `.gd`, `.unity`, `.uasset`, `.FCStd`, `.scad`, `.kicad_pcb`...).

Add your own apps, or change a built-in one (same `id`), in `~/.claude/cockpit.json` (all your projects) or `<project>/.cockpit.json` (that project; it wins). Both are read when a session starts.

```json
{
  "apps": [
    {
      "id": "krita",
      "name": "Krita",
      "color": "#3bacd4",
      "glyph": "K",
      "match": {
        "mcp": "krita",
        "command": "(^|[\\s/])krita(\\s|$)",
        "files": [".kra"]
      },
      "screenshot": { "tool": "get_canvas_image", "args": {} },
      "window": "krita"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Required. Shown on the badge and the screen's caption. |
| `id` | Optional; defaults to the name in lower case. A built-in's id (`blender`, `godot`, `unity`, `unreal`, `freecad`, `openscad`, `kicad`...) replaces it. |
| `color` | `#rgb` or `#rrggbb`. |
| `glyph` | Up to 3 characters, drawn in the app's tile. |
| `match.mcp` | Regular expression (case-insensitive) on the server part of `mcp__<server>__<tool>`. |
| `match.command` | Regular expression (case-insensitive) on a Bash command. |
| `match.files` | File extensions, with their dot. |
| `screenshot` | The MCP tool of the same server that returns a picture: a tool name, or a regular expression on the tool names; `args` are passed to it. |
| `window` | The macOS app name whose window Cockpit may capture. |

Regular expressions are JSON strings, so a backslash is written twice. An entry without a name, with a broken pattern or with nothing to match is ignored.

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

Cockpit keeps 300 calls, 200 files (12 changes per file), 150 agents and 20 workflow runs. Outputs are cut at about 4,000 characters, commands at 4,000 and diffs at 12,000 (an unfolded diff shows 600 lines at most). It keeps six screen frames at most, one per source (a simulator, an emulator, a window, a browser tab, an MCP server, an image file): a new picture replaces its source's last one, and past six the oldest goes, never a device Live follows (an image file is read as is up to about 90 KB, larger ones are shrunk with `sips`). `/clear` resets everything except the selected tab, Live and the watch.
