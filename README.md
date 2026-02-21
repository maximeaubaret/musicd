# Jellyfin Music Daemon

A TypeScript/Bun daemon that plays music from a Jellyfin server.

## Features

- Play music from Jellyfin by item ID
- REST API for control
- CLI tool for easy interaction
- Configurable via JSON config and environment variables

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- `mpv` installed (`sudo apt install mpv` on Ubuntu/Debian)
- Access to a Jellyfin server with username and password

## Setup

1. Install dependencies:

```bash
bun install
```

2. Configure Jellyfin server URL (optional):

```bash
# Edit .env or config/default.json to set your Jellyfin server URL
# Default is http://localhost:8096
```

3. Run the setup wizard:

```bash
bun run cli setup
```

The setup wizard will:

- Prompt for your Jellyfin username and password
- Authenticate with your Jellyfin server
- Save the authentication token securely to `.jellyfin-auth.json`

**Note**: Your username and password are only used during setup. The daemon uses the saved token for all subsequent operations.

## Usage

### Start the daemon

```bash
bun run dev
```

The daemon will start on `http://127.0.0.1:3000` by default.

If you haven't run setup, the daemon will prompt you to do so.

### CLI Commands

```bash
# Run initial setup (required before first use)
bun run cli setup

# Reconfigure authentication
bun run cli setup --force

# Play a Jellyfin item by ID
bun run cli play <jellyfin-item-id>

# Stop playback
bun run cli stop

# Check playback status
bun run cli status

# Check daemon health
bun run cli health
```

### REST API

- `POST /api/play` - Play a Jellyfin item

  ```json
  { "itemId": "abc123..." }
  ```

- `POST /api/stop` - Stop playback

- `GET /api/status` - Get current playback status

- `GET /api/health` - Check daemon health

## Configuration

Configuration is loaded from `config/default.json` and can be overridden with environment variables:

- `JELLYFIN_URL` - Jellyfin server URL (default: http://localhost:8096)
- `DAEMON_PORT` - Daemon HTTP port (default: 3000)
- `DAEMON_HOST` - Daemon bind address (default: 127.0.0.1)
- `AUDIO_DEVICE` - Audio output device (default: "default")

**Authentication**: Credentials are managed via the `setup` command and stored securely in `.jellyfin-auth.json`.

## Development

```bash
# Format code
bun run format

# Lint code
bun run lint
```

## License

MIT
