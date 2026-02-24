# musicd

[![CI](https://github.com/maximeaubaret/musicd/actions/workflows/ci.yml/badge.svg)](https://github.com/maximeaubaret/musicd/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/github/actions/workflow/status/maximeaubaret/musicd/ci.yml?label=tests)](https://github.com/maximeaubaret/musicd/actions/workflows/ci.yml)
[![Release](https://github.com/maximeaubaret/musicd/actions/workflows/release.yml/badge.svg)](https://github.com/maximeaubaret/musicd/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/maximeaubaret/musicd)](https://github.com/maximeaubaret/musicd/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-linux-lightgrey)](https://github.com/maximeaubaret/musicd)

> This project was vibecoded. Use at your own risk.

A lightweight daemon that plays music from a [Jellyfin](https://jellyfin.org) server. Control playback via CLI or REST API.

## Features

- Stream music from Jellyfin
- Queue management with auto-play
- REST API for integration
- CLI with interactive search
- Optional password authentication

## Requirements

- Linux (x64 or ARM64)
- [ffplay](https://ffmpeg.org/) for audio playback (`sudo apt install ffmpeg`)
- Access to a Jellyfin server

## Installation

### Pre-built Binaries

Download the server (daemon) and CLI for your architecture:

```bash
# x64
curl -L https://github.com/maximeaubaret/musicd/releases/latest/download/musicd-server-linux-x64 -o musicd-server
curl -L https://github.com/maximeaubaret/musicd/releases/latest/download/musicd-linux-x64 -o musicd
chmod +x musicd-server musicd

# ARM64
curl -L https://github.com/maximeaubaret/musicd/releases/latest/download/musicd-server-linux-arm64 -o musicd-server
curl -L https://github.com/maximeaubaret/musicd/releases/latest/download/musicd-linux-arm64 -o musicd
chmod +x musicd-server musicd
```

### From Source

Requires [Bun](https://bun.sh) runtime:

```bash
git clone https://github.com/maximeaubaret/musicd.git
cd musicd
bun install
```

## Quick Start

1. **Start the daemon:**

   ```bash
   ./musicd-server              # pre-built
   bun run dev                  # from source
   ```

2. **Run setup** (first time only):

   ```bash
   ./musicd setup               # pre-built
   bun run cli setup            # from source
   ```

3. **Play music:**

   ```bash
   ./musicd browse "artist or song"
   bun run cli browse "artist or song"
   ```

## CLI Commands

### Discovery & Playback

| Command             | Alias | Description                         |
| ------------------- | ----- | ----------------------------------- |
| `browse [query]`    | `b`   | Interactive search and play music   |
| `browse -q [query]` | -     | Interactive search and add to queue |
| `search <query>`    | -     | Search library (non-interactive)    |

### Queue Management

| Command             | Alias | Description              |
| ------------------- | ----- | ------------------------ |
| `queue`             | `q`   | Show queue (interactive) |
| `queue show`        | -     | Show queue (explicit)    |
| `queue clear`       | -     | Clear the queue          |
| `queue add <query>` | -     | Search and add to queue  |
| `queue add -i <id>` | -     | Add by item ID to queue  |

### Playback Control

| Command    | Alias  | Description               |
| ---------- | ------ | ------------------------- |
| `play`     | `p`    | Play/resume current queue |
| `pause`    | `pp`   | Pause playback            |
| `stop`     | -      | Stop playback             |
| `next`     | `n`    | Skip to next track        |
| `previous` | `prev` | Previous track            |
| `status`   | `s`    | Show current playback     |

### Setup

| Command | Alias | Description                |
| ------- | ----- | -------------------------- |
| `setup` | -     | Authenticate with Jellyfin |

### Global Options

| Option                  | Description                  |
| ----------------------- | ---------------------------- |
| `--json`                | Output results as JSON       |
| `--profile <name>`      | Use named connection profile |
| `--host <host>`         | Daemon host address          |
| `--port <port>`         | Daemon port                  |
| `--password <password>` | Daemon password              |
| `--print-logs`          | Enable debug logging         |

The `--json` flag makes all commands output structured JSON to stdout, suitable for
scripting and piping. Interactive commands (browse, queue) output data instead of
launching prompts. Errors are output as `{ "error": "..." }` to stderr.

```bash
musicd status --json                    # JSON playback status
musicd search "query" --json             # JSON search results
musicd next --json                       # JSON with new track info
musicd queue --json                      # JSON queue dump (no prompt)
musicd status --json | jq .state         # Pipe to jq
```

## Configuration

Configuration is split into two files:

### Server Config (`~/.config/musicd/server.json`)

Used by the daemon:

```json
{
  "jellyfin": {
    "serverUrl": "http://localhost:8096"
  },
  "daemon": {
    "port": 8765,
    "host": "127.0.0.1",
    "password": "optional-api-password"
  },
  "audio": {
    "device": "default"
  }
}
```

### CLI Config (`~/.config/musicd/cli.json`)

Connection profiles for the CLI:

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "host": "127.0.0.1",
      "port": 8765,
      "password": "optional-api-password"
    },
    "home-server": {
      "host": "192.168.1.100",
      "port": 8765,
      "password": "different-password"
    }
  }
}
```

### CLI Connection Options

# Uses default profile

musicd status
musicd --profile home-server status
musicd --host 10.0.0.5 --port 8765 --password secret status

# JSON output for scripting

musicd --json status

````

### Environment Variables

**Server:**

| Variable              | Description         |
| --------------------- | ------------------- |
| `JELLYFIN_SERVER_URL` | Jellyfin server URL |
| `DAEMON_BIND_HOST`    | Address to bind to  |
| `DAEMON_BIND_PORT`    | Port to bind to     |
| `DAEMON_PASSWORD`     | API password        |
| `AUDIO_DEVICE`        | Audio output device |

**CLI:**

| Variable          | Description               |
| ----------------- | ------------------------- |
| `DAEMON_HOST`     | Daemon host to connect to |
| `DAEMON_PORT`     | Daemon port to connect to |
| `DAEMON_PASSWORD` | API password              |

### Security

Set `daemon.password` in server config when exposing the daemon to your network. The CLI uses profiles or `DAEMON_PASSWORD` to authenticate.

## REST API

All endpoints require `Authorization: Bearer <password>` header if `DAEMON_PASSWORD` is set.

| Method | Endpoint              | Description                       |
| ------ | --------------------- | --------------------------------- |
| POST   | `/api/auth`           | Authenticate with Jellyfin        |
| POST   | `/api/play`           | Play an item `{"itemId": "..."}`  |
| POST   | `/api/stop`           | Stop playback                     |
| GET    | `/api/status`         | Playback status                   |
| POST   | `/api/queue/add`      | Add to queue `{"itemIds": [...]}` |
| GET    | `/api/queue`          | Get queue                         |
| POST   | `/api/queue/clear`    | Clear queue                       |
| POST   | `/api/queue/next`     | Next track                        |
| POST   | `/api/queue/previous` | Previous track                    |
| GET    | `/api/search?q=...`   | Search music                      |
| GET    | `/api/health`         | Health check (no auth required)   |

## Development

```bash
bun install          # Install dependencies
bun run dev          # Start daemon with watch mode
bun run cli <cmd>    # Run CLI commands
bun run format       # Format code
bun run lint         # Lint code
````

### Project Structure

```
packages/
  shared/   # Types, config, utilities
  client/   # HTTP client library
  server/   # Daemon server
  cli/      # Command-line interface
```

## License

MIT
