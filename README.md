# ClawMind Local Context Engine Plugin for OpenClaw

`clawmind` is a native OpenClaw plugin that registers a custom context engine via `api.registerContextEngine(id, factory)`. Instead of sending conversation history to a remote service, it compacts older session messages into a local Markdown summary file and keeps only the recent messages verbatim in the runtime context.

Repository: [CodeKungfu/clawmind](https://github.com/CodeKungfu/clawmind)

## Features

- Registers a native OpenClaw context engine named `clawmind`
- Triggers compaction when accumulated context exceeds a configurable threshold
- Writes a local `.clawmind.md` summary file for each session
- Keeps the latest messages verbatim while injecting summarized historical context as a system message
- Works fully offline after installation and does not call `fetch`
- Validates plugin configuration through `openclaw.plugin.json`

## How It Works

1. OpenClaw passes the full session message list to the plugin.
2. When total context length exceeds `compressionThreshold`, ClawMind summarizes the older portion of the conversation into Markdown.
3. The summary is written to disk, either next to the OpenClaw session file or inside `summaryDir`.
4. On future `assemble()` calls, ClawMind returns:
   - one system message containing the local Markdown summary
   - the most recent `keepRecentMessages` messages unchanged

This gives you a deterministic local compaction flow without depending on an external API.

## Project Layout

```text
clawmind/
|- src/
|  |- index.ts
|  `- types.ts
|- openclaw.plugin.json
|- package.json
|- tsconfig.json
`- README.md
```

## Requirements

- Node.js 22 or newer
- OpenClaw with plugin support enabled

## Install for Local Development

```bash
npm install
npm run build
openclaw plugins install .
```

After installing, restart the OpenClaw gateway so the plugin can be discovered and loaded.

## Install from a Published Package

Once the package is published, users can install it with:

```bash
openclaw plugins install clawmind
```

OpenClaw checks ClawHub first and falls back to npm automatically.

## OpenClaw Configuration

Configure the plugin in your OpenClaw config file and select it as the active context engine:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "clawmind"
    },
    "entries": {
      "clawmind": {
        "enabled": true,
        "config": {
          "compressionThreshold": 4000,
          "keepRecentMessages": 12,
          "entryCharLimit": 280,
          "summaryDir": "",
          "debug": false
        }
      }
    }
  }
}
```

## Configuration Reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `compressionThreshold` | `number` | `4000` | Trigger compaction when accumulated context characters exceed this threshold |
| `keepRecentMessages` | `number` | `12` | Number of most recent messages to preserve verbatim in runtime context |
| `entryCharLimit` | `number` | `280` | Maximum character length for each summarized Markdown entry |
| `summaryDir` | `string` | `""` | Optional directory for generated summary files; defaults next to the session file |
| `debug` | `boolean` | `false` | Enables verbose gateway logs |

## Generated Summary Files

By default ClawMind writes a file like:

```text
<session-directory>/<session-id>.clawmind.md
```

If `summaryDir` is set, files are written there instead. The generated Markdown is a compact transcript-style summary of earlier messages, with each historical message normalized and truncated to `entryCharLimit`.

## Design Notes

- ClawMind performs deterministic local compaction. It does not use an LLM or remote summarization service.
- The summary file is regenerated from the current session history whenever compaction runs.
- `assemble()` uses the saved summary plus the recent message tail to reduce prompt size.
- Since the summary is stored on disk, sessions can reload previous compacted state during `bootstrap()`.

## Development Notes

- Build output is emitted to `dist/`
- `npm pack` and `npm publish` will run `npm run build` first through `prepack`
- `npm run clean` removes `dist/`

## License

ISC
