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
- Queue management with persistent loop and random modes
- Library browsing, artwork proxying, search, and seeking
- Optional mpv backend with gapless seeking and native persistent volume
- Optional YouTube playback through `yt-dlp`
- REST API for integration
- CLI with interactive search
- Optional bearer-password authentication

## Requirements

- Linux (x64 or ARM64)
- [ffplay](https://ffmpeg.org/) or [mpv](https://mpv.io/) for audio playback
- Access to a Jellyfin server
- Optional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube playback

## Installation

### Pre-built binaries

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

### From source

Requires the [Bun](https://bun.sh) runtime:

```bash
git clone https://github.com/maximeaubaret/musicd.git
cd musicd
bun install
```

## Quick start

1. On a clean install, start the daemon in one terminal:

   ```bash
   ./musicd-server       # pre-built
   bun run server        # from source
   ```

   With no saved configuration and authentication, musicd enters setup mode at
   `http://127.0.0.1:8765`. Setup mode is loopback-only and exposes just
   `GET /api/health` and `POST /api/auth`; playback is not available yet. Leave
   this process running while completing the next step.

2. In a second terminal, run setup:

   ```bash
   ./musicd setup                                      # pre-built
   bun run cli setup                                   # from source
   ./musicd setup --jellyfin-url https://jellyfin.example
   ```

   When `--jellyfin-url` is omitted, setup prompts for it and defaults to
   `http://localhost:8096`. It then prompts for the Jellyfin username and
   password. A successful setup atomically saves the validated server
   configuration and Jellyfin authentication state.

3. Stop the setup-mode process with Ctrl+C, then start the daemon again with the
   same command from step 1. The second start loads the saved state and exposes
   the normal playback API.

4. Play music from another terminal:

   ```bash
   ./musicd browse "artist or song"
   bun run cli browse "artist or song"
   ```

If the server configuration is missing, or the authentication state is missing or
invalid, the daemon safely returns to loopback-only setup mode. A malformed server
configuration instead stops startup with a configuration error so it can be fixed.
Setup never writes a CLI connection profile; configure one separately when the CLI
will not use the local defaults.

## CLI

Global connection options may appear before the command.

### Discovery and playback

| Command             | Alias  | Behavior                                                   |
| ------------------- | ------ | ---------------------------------------------------------- |
| `browse [query]`    | `b`    | Select an item, replace the queue, and play it immediately |
| `browse -q [query]` | -      | Select an item and append it without starting playback     |
| `search <query>`    | -      | Search the Jellyfin library without changing playback      |
| `play`              | `p`    | Resume paused playback or a stopped, restored queue        |
| `pause`             | `pp`   | Pause playback                                             |
| `stop`              | -      | Stop playback                                              |
| `next`              | `n`    | Advance according to the current queue mode                |
| `previous`          | `prev` | Go to the previous queue item                              |
| `status`            | `s`    | Show playback, queue position, and enabled queue modes     |

### Queue management

| Command                         | Alias | Behavior                                                 |
| ------------------------------- | ----- | -------------------------------------------------------- |
| `queue`                         | `q`   | Interactively show the queue and optionally play a track |
| `queue show`                    | `ls`  | Same behavior as `queue`                                 |
| `queue clear`                   | -     | Clear the queue                                          |
| `queue add <query>`             | -     | Search, select, and append without starting playback     |
| `queue add --id <jellyfin-id>`  | -     | Append a Jellyfin track, album, or artist by ID          |
| `queue add --youtube-url <url>` | -     | Append a YouTube URL                                     |
| `queue add ... --loop`          | -     | Append, then idempotently enable loop mode               |
| `queue loop [on\|off]`          | -     | Set loop explicitly; omit the state to toggle            |
| `queue random [on\|off]`        | -     | Set random explicitly; omit the state to toggle          |
| `queue shuffle`                 | -     | Reorder the queue while preserving the active track      |

CLI `queue add` never clears the existing queue, starts playback, or replaces the
current track. Jellyfin album and artist IDs expand to all their playable tracks.
YouTube URLs and Jellyfin IDs can also be mixed in one REST request; their expanded
tracks retain request order. `random` changes how the next track is selected,
whereas `shuffle` changes the stored queue order. Loop and random settings persist
with the queue.

### Setup

| Command                        | Behavior                                       |
| ------------------------------ | ---------------------------------------------- |
| `setup [--jellyfin-url <url>]` | Configure and authenticate the Jellyfin server |

### Global options

| Option                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `--json`                | Machine-readable output for operational commands |
| `--profile <name>`      | Use a named connection profile                   |
| `--host <host>`         | Override the daemon host                         |
| `--port <port>`         | Override the daemon port (`1` to `65535`)        |
| `--protocol <protocol>` | Override the daemon protocol (`http` or `https`) |
| `--password <password>` | Override the daemon bearer password              |
| `--allow-insecure-http` | Permit credentials over remote HTTP              |
| `--print-logs`          | Enable redacted debug logging                    |

Setup follows the same transport policy as every credential-bearing request:
remote connections require HTTPS unless `--allow-insecure-http` is explicitly
selected.

### JSON output

For operational commands, `--json` writes one JSON value to stdout on success.
Failures handled by a command action write `{ "error": "..." }` to stderr and exit
nonzero. Commander syntax/option errors remain human-readable, as do the early
`queue add` errors for a missing source or invalid `--youtube-url`; validate those
inputs before invoking the CLI in JSON automation. Queue mode side effects,
including `queue add --loop`, finish before the success value is emitted.
Interactive queue views become non-interactive queue dumps. A JSON `browse`
request returns search results without prompting or playing; use a result ID with
`queue add --id` for a deterministic queue mutation. Search-based `queue add` in
JSON mode succeeds only when the search has one result and otherwise asks the
caller to use `--id`. The interactive `setup` wizard does not implement JSON
output.

```bash
musicd --json status | jq .state
musicd --json search "query" | jq .results
musicd --json queue
musicd --json queue add --id ITEM_ID --loop
musicd --json queue loop on
```

## Configuration and storage

musicd uses the XDG base directories. Defaults are shown below; setting
`XDG_CONFIG_HOME` or `XDG_DATA_HOME` relocates the corresponding files.

| File                               | Purpose                                       |
| ---------------------------------- | --------------------------------------------- |
| `~/.config/musicd/server.json`     | Daemon and Jellyfin server configuration      |
| `~/.config/musicd/cli.json`        | CLI connection profiles                       |
| `~/.local/share/musicd/auth.json`  | Validated Jellyfin access token and identity  |
| `~/.local/share/musicd/queue.json` | Queue, position, modes, and volume state (v3) |

Authentication state is not stored in `server.json`, the working directory, or a
`.jellyfin-auth.json` file. Sensitive setup files are created with owner-only file
permissions.

### Server configuration

```json
{
  "jellyfin": {
    "serverUrl": "http://localhost:8096"
  },
  "daemon": {
    "host": "127.0.0.1",
    "port": 8765,
    "password": "optional-api-password"
  },
  "audio": {
    "device": "default",
    "backend": "mpv"
  },
  "state": {
    "restoreQueue": true
  }
}
```

The daemon defaults are host `127.0.0.1`, port `8765`, audio device `default`,
the `ffplay` backend, and queue restoration enabled. Select `mpv` for native
in-place seeking, pause, decoder-clock position tracking, and per-stream volume.
The daemon listener speaks HTTP; use a reverse proxy for remote HTTPS as
described under [Remote use](#remote-use).

### CLI configuration

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "host": "127.0.0.1",
      "port": 8765,
      "protocol": "http",
      "password": "optional-api-password"
    },
    "remote": {
      "host": "music.example.com",
      "port": 443,
      "protocol": "https",
      "password": "different-password"
    },
    "trusted-lan": {
      "host": "192.168.1.100",
      "port": 8765,
      "protocol": "http",
      "password": "different-password",
      "allowInsecureHttp": true
    }
  }
}
```

CLI arguments override environment variables, which override the selected
profile, which overrides the built-in defaults (`127.0.0.1:8765` over HTTP).

```bash
musicd status
musicd --profile remote status
musicd --protocol https --host music.example.com --port 443 status
musicd --host 192.168.1.100 --password secret --allow-insecure-http status
```

### Environment variables

The daemon and CLI load `.env` from the current working directory. Server
variables override an existing `server.json`; they do not replace the clean-install
setup flow.

| Server variable       | Meaning                               |
| --------------------- | ------------------------------------- |
| `JELLYFIN_SERVER_URL` | Jellyfin server URL                   |
| `DAEMON_BIND_HOST`    | Daemon listener address               |
| `DAEMON_BIND_PORT`    | Daemon listener port (`1` to `65535`) |
| `DAEMON_PASSWORD`     | Optional API bearer password          |
| `AUDIO_DEVICE`        | ffplay output device                  |

| CLI variable                 | Meaning                                    |
| ---------------------------- | ------------------------------------------ |
| `DAEMON_HOST`                | Daemon host to connect to                  |
| `DAEMON_PORT`                | Daemon port to connect to (`1` to `65535`) |
| `DAEMON_PROTOCOL`            | Daemon protocol (`http` or `https`)        |
| `DAEMON_PASSWORD`            | Daemon bearer password                     |
| `DAEMON_ALLOW_INSECURE_HTTP` | Remote HTTP override (`true` or `false`)   |

`JELLYFIN_URL` remains accepted as a compatibility alias for
`JELLYFIN_SERVER_URL`; new configurations should use the canonical name above.

## Remote use

musicd does not terminate TLS itself. The recommended remote topology is an HTTPS
reverse proxy such as Caddy or nginx on the daemon host:

```text
remote CLI -- HTTPS --> reverse proxy -- HTTP loopback --> musicd 127.0.0.1:8765
```

Keep `daemon.host` on `127.0.0.1`, configure the proxy to forward to
`http://127.0.0.1:8765`, set `daemon.password`, and use an `https` CLI profile for
the proxy hostname and external port. HTTP is accepted by default for recognized
loopback hosts (`localhost`, `127.0.0.0/8`, and `::1`) because traffic does not
leave the machine.

The client refuses any remote HTTP request that would carry either the daemon
bearer password or Jellyfin setup credentials. For an intentionally trusted
network only, opt in with profile field `allowInsecureHttp: true`, environment
variable `DAEMON_ALLOW_INSECURE_HTTP=true`, or CLI flag `--allow-insecure-http`.
When a daemon bearer password is configured, the CLI also warns that it will be
sent without transport encryption. Remote unauthenticated HTTP is not blocked,
but it provides neither confidentiality nor access control and is not recommended.

Debug logs redact daemon passwords, Jellyfin passwords and tokens, authorization
headers, and credential-bearing query parameters. Jellyfin streams are passed to
the selected player as seekable URLs with the token in an HTTP header. This makes
MP4-family files with indexes at the end playable, but the header is visible to
local process-argument inspection even though musicd redacts it from logs. Use
HTTPS for remote Jellyfin servers and restrict local process inspection. Prefer a
password in a CLI profile over `--password`, because command-line arguments can
also be visible to local process inspection tools.

## REST API

In normal mode, `GET /api/health` is always public. If `daemon.password` (or the
`DAEMON_PASSWORD` server override) is set, every other normal-mode endpoint
requires `Authorization: Bearer <password>`. Setup mode has no playback routes and
exposes only the public health endpoint and setup authentication endpoint.

| Method | Endpoint                     | Behavior                                                   |
| ------ | ---------------------------- | ---------------------------------------------------------- |
| GET    | `/api/health`                | Public health, uptime, and version                         |
| POST   | `/api/auth`                  | Authenticate setup or refresh the configured Jellyfin auth |
| POST   | `/api/play`                  | Smart play with `{}` or replace/play an `itemId`           |
| POST   | `/api/pause`                 | Pause playback                                             |
| POST   | `/api/resume`                | Resume playback                                            |
| POST   | `/api/stop`                  | Stop playback                                              |
| POST   | `/api/seek`                  | Seek with `{ "position": seconds }`                        |
| GET    | `/api/volume`                | Get native playback volume                                 |
| POST   | `/api/volume`                | Set `{ "volume": 0..100 }`                                 |
| GET    | `/api/status`                | Playback, queue, position, and queue modes                 |
| POST   | `/api/queue/add`             | Resolve and add one or more queue items                    |
| GET    | `/api/queue`                 | Get the queue and active position                          |
| POST   | `/api/queue/clear`           | Clear the queue                                            |
| POST   | `/api/queue/next`            | Advance according to queue mode                            |
| POST   | `/api/queue/previous`        | Play the previous item                                     |
| POST   | `/api/queue/play/:index`     | Play a zero-based queue position                           |
| POST   | `/api/queue/remove/:index`   | Remove a zero-based queue position                         |
| POST   | `/api/queue/loop`            | Toggle loop mode (compatibility endpoint)                  |
| POST   | `/api/queue/random`          | Toggle random mode (compatibility endpoint)                |
| POST   | `/api/queue/shuffle`         | Shuffle while preserving the active track                  |
| POST   | `/api/queue/mode`            | Explicitly set `{ "loop"?: boolean, "random"?: boolean }`  |
| GET    | `/api/queue/mode`            | Get the `success` and `queueMode: { loop, random }` fields |
| GET    | `/api/search?q=...&limit=20` | Search music (`limit` is `1` to `100`)                     |
| GET    | `/api/album/:id`             | Get album metadata and tracks                              |
| GET    | `/api/artist/:id`            | Get artist metadata and tracks                             |
| GET    | `/api/library/:kind`         | Browse albums, artists, or songs with pagination           |
| GET    | `/api/artwork/:id`           | Stream proxied Jellyfin artwork                            |

`POST /api/queue/add` accepts this body:

```json
{
  "itemIds": ["jellyfin-track-or-container-id", "https://youtu.be/example"],
  "clearQueue": false,
  "playNow": false
}
```

`itemIds` must be a non-empty array. Each Jellyfin album or artist expands to its
playable tracks. `clearQueue` and `playNow` both default to `false`. With
`playNow: false`, adding never starts or replaces playback. With `playNow: true`,
the daemon starts the first track resolved from this request, including when it
was appended to an existing queue. `clearQueue: true` clears the old queue before
adding. `POST /api/play` retains the direct-play behavior for existing clients;
an empty body performs smart play, while a supplied `itemId` replaces the queue
and starts that selection.

Compatibility is preserved for the loop and random toggle endpoints, while new
automation should prefer the idempotent `/api/queue/mode` setter. Queue-state v1
and v2 files are migrated to v3 and re-saved; unsupported or malformed state is
ignored safely. Existing response shapes are retained where possible and queue
mode fields are additive.

## Development and release verification

The release candidate is verified without starting, stopping, or probing a daemon:

```bash
bun install
bun run lint
bun run format:check
bun run typecheck
bun test
```

`format:check` is read-only. The complete Bun suite uses in-process application,
fake transport, playback-backend, subprocess, and temporary-XDG seams; it does not
need a running development daemon.

### Project structure

```text
packages/
  shared/   # Types, config, storage, and utilities
  client/   # Validating HTTP client library
  server/   # Daemon, REST API, and playback services
  cli/      # Command-line interface
```

## License

MIT
