# Cockpit

[Français](README.md) · **English**

A live pane that shows what Claude is doing: the commands it runs and their output, the files it changes with their diffs, its subagents (including the agents of ultracode workflows), and the screen of whatever app Claude drives: a browser, a simulator, an emulator, Blender, Godot, Unity, Unreal, FreeCAD, OpenSCAD, KiCad, or any app you name.

Cockpit only watches. It never blocks or changes a tool call. If something breaks on its side, the error is swallowed and the session carries on.

## Opening it

- **Button above the prompt**: while the pane is closed, a `◆ Open Cockpit · 198` button reopens it in one click.
- **Button at the bottom right**, beside the mode labels: `◆ 198 · 2 agents` (tool calls, running agents). One click opens or closes the pane.
- **Desktop app**: the pane opens by itself as a sidebar, once per session. To turn that off, disable the plugin's `autoOpen` option.
- **Command**: `/cockpit` opens the pane, `/cockpit close` closes it, `/cockpit live [on|off]` sets continuous screen capture, `/cockpit watch <App>` follows an app's window (macOS), `/cockpit watch off` stops.

## What you see (desktop app)

One view, no tabs, as if you were looking over Claude's shoulder.

- **Header**: tool calls, commands, files changed (`+`/`−`), running agents, errors, session time, and a curve of the last 6 minutes of activity.
- **NOW**, what Claude is doing right now, drawn large:
  - a **command** in a terminal window: the command, a cursor while it runs, then the end of its output;
  - a **file change** with its colored diff (a subagent's too);
  - an **agent** or a **workflow** started: its state, what it is doing this moment, a progress bar with one segment per agent;
  - the **screen**: the browser, the simulator, an app's viewport or window, or an image Claude just looked at or rendered, refreshed after each action. Its caption says where it comes from (`OpenSCAD · out/preview.png`, `Blender · get viewport screenshot`, `Krita · untitled.kra`).

  A call that works with a known app carries that app's badge (its colour and name), and an app's command is titled by what it does: `Blender · Render`, `Godot · Export`, `OpenSCAD · Render`. A binary asset a command or a Write changed (`.blend`, `.FCStd`, `.uasset`, `.umap`, `.stl`, `.glb`...) gets an "Asset changed" card with its size instead of a diff.
  
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
| Any image in a tool's result | Nothing. Whatever the tool (a `Read` of a PNG, an MCP tool that renders or captures), the image Claude sees shows on the screen. |
| An image a command wrote | Nothing. After a command ends, the image files it names (`openscad -o out/preview.png`, `--output=shot.jpg`, `> plot.png`) that it wrote are looked up; the newest shows. Patterns such as Blender's `render_####.png` are skipped. |
| An app's MCP screenshot tool | Nothing. After an action on an app's MCP server (blender-mcp, a Godot or Unity server...) whose result holds no image, Cockpit calls that server's screenshot tool (`get_viewport_screenshot`, or a tool named like `screenshot` / `capture_viewport`), only when the app allows that call without asking you. |
| An app's window (macOS) | `/cockpit watch <App>`, or `"window"` set on an app of your `cockpit.json`, and the **Screen Recording** permission for Claude (System Settings › Privacy & Security › Screen Recording). Only that app's frontmost window is captured (`screencapture -l <window id>`), never the whole screen. |

The "Live screen" button captures the simulator or emulator every 2 s; "Capture screen" takes one frame. In the desktop app the frame is drawn as an SVG; in the terminal through the kitty graphics protocol (kitty, Ghostty).

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

Cockpit keeps 300 calls, 200 files (12 changes per file), 150 agents and 20 workflow runs. Outputs are cut at about 4,000 characters and diffs at 12,000. Only one screen frame is kept: each new one replaces the last (an image file is read as is up to about 90 KB, larger ones are shrunk with `sips`). `/clear` resets everything except the selected tab.
