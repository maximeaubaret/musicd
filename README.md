# musicd

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
   ./musicd play "artist or song"
   bun run cli play "artist or song"
   ```

## CLI Commands

| Command                | Description                       |
| ---------------------- | --------------------------------- |
| `setup`                | Authenticate with Jellyfin        |
| `play <query>`         | Search and play interactively     |
| `play <query> --queue` | Add to queue instead of replacing |
| `search <query>`       | Search without playing            |
| `stop`                 | Stop playback                     |
| `status`               | Show current track                |
| `queue`                | View and select from queue        |
| `queue-clear`          | Clear the queue                   |
| `next`                 | Skip to next track                |
| `previous`             | Previous track                    |
| `health`               | Check daemon status               |

## Configuration

Create a config file at `~/.config/musicd/config.json`:

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

Environment variables can override config values: `JELLYFIN_URL`, `DAEMON_PORT`, `DAEMON_HOST`, `DAEMON_PASSWORD`, `AUDIO_DEVICE`.

### Security

Set `daemon.password` when exposing the daemon to your network. The CLI reads `DAEMON_PASSWORD` from the environment to authenticate.

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
```

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
