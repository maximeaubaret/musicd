# Jellyfin Music Daemon

A TypeScript/Bun daemon that plays music from a Jellyfin server.

## Features

- Play music from Jellyfin by item ID
- Queue management with auto-play next
- Interactive search with expandable albums and artists
- REST API for control
- CLI tool for easy interaction
- Configurable via JSON config and environment variables
- Monorepo structure with separate packages for shared code, client, server, and CLI

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- `mpv` installed (`sudo apt install mpv` on Ubuntu/Debian)
- Access to a Jellyfin server with username and password

## Setup

1. Install dependencies and link workspace packages:

```bash
bun install
```

2. Configure Jellyfin server URL (optional):

```bash
# Edit .env or config/default.json to set your Jellyfin server URL
# Default is http://localhost:8096
```

3. Start the daemon:

```bash
bun run dev
```

4. Run the setup wizard (in another terminal):

```bash
bun run cli setup
```

The setup wizard will:

- Prompt for your Jellyfin username and password
- Authenticate with your Jellyfin server via the daemon
- Save the authentication token securely to `.jellyfin-auth.json`

**Note**: Your username and password are only used during setup. The daemon uses the saved token for all subsequent operations.

## Usage

### Start the daemon

```bash
bun run dev
```

The daemon will start on `http://127.0.0.1:8765` by default.

If you haven't run setup, the daemon will prompt you to do so.

### CLI Commands

```bash
# Run initial setup (required before first use, daemon must be running)
bun run cli setup

# Reconfigure authentication
bun run cli setup --force

# Search and play music interactively
bun run cli play "song or artist name"

# Add to queue instead of replacing
bun run cli play "song name" --queue

# Search for music (non-interactive)
bun run cli search "query" --limit 10

# Stop playback
bun run cli stop

# Check playback status
bun run cli status

# Check daemon health
bun run cli health

# View and select from queue
bun run cli queue

# Clear queue
bun run cli queue-clear

# Skip to next song
bun run cli next

# Go to previous song
bun run cli previous
```

### REST API

- `POST /api/auth` - Authenticate with Jellyfin (used by setup)
- `POST /api/play` - Play a Jellyfin item
- `POST /api/stop` - Stop playback
- `GET /api/status` - Get current playback status
- `POST /api/queue/add` - Add items to queue
- `GET /api/queue` - Get current queue
- `POST /api/queue/clear` - Clear queue
- `POST /api/queue/next` - Skip to next song
- `POST /api/queue/previous` - Go to previous song
- `POST /api/queue/play/:index` - Play from queue position
- `POST /api/queue/remove/:index` - Remove item from queue
- `GET /api/search` - Search for music
- `GET /api/album/:id` - Get album details with tracks
- `GET /api/artist/:id` - Get artist details with tracks
- `GET /api/health` - Check daemon health

## Configuration

Configuration is loaded from `config/default.json` and can be overridden with environment variables:

- `JELLYFIN_URL` - Jellyfin server URL (default: http://localhost:8096)
- `DAEMON_PORT` - Daemon HTTP port (default: 8765)
- `DAEMON_HOST` - Daemon bind address (default: 127.0.0.1)
- `AUDIO_DEVICE` - Audio output device (default: "default")

**Authentication**: Credentials are managed via the `setup` command and stored securely in `.jellyfin-auth.json`.

## Project Structure

This project uses Bun workspaces with 4 packages:

- **`@musicd/shared`** - Shared types, configuration, and utilities
- **`@musicd/client`** - HTTP client for daemon API
- **`@musicd/server`** - HTTP daemon server
- **`@musicd/cli`** - Command-line interface

## Development

```bash
# Install dependencies and link workspace packages
bun install

# Format code
bun run format

# Lint code
bun run lint

# Clean build artifacts (if any were generated)
bun run clean
```

**Note**: No build step required! Bun runs TypeScript directly.

## License

MIT
