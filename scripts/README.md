# Session Sync Hook

Automatically saves Claude Code sessions to Team Memory MCP server.

**Two triggers:**
- **Stop** — after every Claude response, with 1-hour debounce per session
- **SessionEnd** — when session terminates (always syncs, no debounce)

Long-running sessions (1-3 days) get synced hourly. Finished sessions get a final sync immediately.

## Setup

### 1. Set environment variables

Add to your `~/.claude/settings.json` in the `"env"` section:

```json
{
  "env": {
    "TM_SERVER_URL": "http://10.61.11.54:3846",
    "TM_TOKEN": "tm_your_agent_token_here",
    "TM_PROJECT_ID": "your-project-uuid"
  }
}
```

### 2. Register hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:/MCP/team-memory-mcp/scripts/session-sync.cjs",
            "timeout": 30
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:/MCP/team-memory-mcp/scripts/session-sync.cjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

> **Note:** Use the absolute path to `session-sync.cjs` on your machine.

### 3. Verify

After working for 1 hour, check:
- Sessions list: `http://10.61.11.54:3846` → UI
- Or via MCP: `session_list` tool

## How it works

```
Claude responds (Stop event)
        │
        ▼
Debounce check: passed 1 hour since last sync?
├─ No → exit (do nothing)
└─ Yes ↓

Session ends (SessionEnd event)
        │
        ▼ (always syncs)

Parse JSONL → extract user/assistant messages
        │
        ▼
POST to server via MCP session_import
        │
        ▼
Server: instant save → queue → background worker
├─ LLM summary (~55 sec)
├─ Embedding → Qdrant (~3 min)
└─ Duplicate detection: if session already exists
   and has MORE messages → updates it (upsert)
```

## Debounce state

Sync timestamps stored in `~/.claude/.session-sync/{session_id}.json`.
This ensures each user's sync cadence is offset naturally — no clock-aligned stampedes.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TM_SERVER_URL` | `http://10.61.11.54:3846` | Team Memory server URL |
| `TM_TOKEN` | — | Agent bearer token (required) |
| `TM_PROJECT_ID` | — | Project UUID (optional) |

## For Cline / RooCode users

The hook script only works with Claude Code. For other tools, use the same
script via cron or file watcher (adjust JSONL parsing for the tool's format).
