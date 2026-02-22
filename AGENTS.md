# Agent Instructions

This document contains instructions for AI agents working on this project.

## Project Overview

A TypeScript/Bun daemon that plays music from a Jellyfin server. Uses Hono for HTTP API, Commander for CLI, and Zod for validation.

**Monorepo Structure**: This project uses Bun workspaces with 4 packages:

- `@musicd/shared` - Shared types, configuration, utilities
- `@musicd/client` - HTTP client for daemon API
- `@musicd/server` - HTTP daemon server
- `@musicd/cli` - CLI tool

## Configuration

Configuration is split into two files in `~/.config/musicd/`:

### Server Config (`server.json`)

Used by the daemon:

```json
{
  "jellyfin": {
    "serverUrl": "http://localhost:8096"
  },
  "daemon": {
    "port": 8765,
    "host": "127.0.0.1",
    "password": "your-secure-password-here"
  },
  "audio": {
    "device": "default"
  }
}
```

### CLI Config (`cli.json`)

Connection profiles for the CLI:

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "host": "127.0.0.1",
      "port": 8765,
      "password": "your-secure-password-here"
    }
  }
}
```

### CLI Connection Options

```bash
musicd status                              # Uses default profile
musicd --profile home-server status        # Use named profile
musicd --host 10.0.0.5 --port 8765 status  # Override with CLI args
```

### Authentication

- If `daemon.password` is set in server config, all API requests require `Authorization: Bearer <password>` header
- Health endpoint (`/api/health`) is always accessible without authentication
- CLI reads password from profile or `DAEMON_PASSWORD` environment variable

## Build, Lint, and Test Commands

### Development

```bash
bun install              # Install dependencies and link workspace packages
bun run dev              # Start the daemon with watch mode
bun run cli              # Run the CLI tool
bun run cli <command>    # Run specific CLI commands (setup, play, search, etc.)
```

**Note**: No build step required! Bun runs TypeScript directly.

### Code Quality

```bash
bun run format           # Format all files with Prettier
bun run lint             # Lint all packages with ESLint
bun run clean            # Clean dist and bin directories
```

### Testing

**Note**: No test framework is currently configured. When adding tests:

- Use Bun's built-in test runner (`bun test`)
- Place test files alongside source files with `.test.ts` suffix
- Run single test: `bun test path/to/file.test.ts`

## Development Workflow

### Server Management

**IMPORTANT**: Agents should NEVER start, stop, restart, or kill the development server on their own.

- ❌ Do NOT run `bun run dev` to test changes
- ❌ Do NOT kill running daemon processes
- ❌ Do NOT check if the server is running
- ❌ Do NOT attempt to test API endpoints by making HTTP requests

**Why**: The user manages their own development environment and server lifecycle. The agent's role is to write code, not to manage runtime processes.

**What to do instead**:

- ✅ Write the code changes
- ✅ Verify TypeScript types with your editor/LSP
- ✅ Report completion and let the user test
- ✅ If asked to verify functionality, suggest commands the user can run

**Example**:

```
Agent: I've added the new API endpoints. You can test them by:
1. Restarting your daemon
2. Running: curl http://localhost:8765/api/album/123
```

### Releases

**IMPORTANT**: Before performing any release, you MUST read `RELEASING.md` for the complete release process and instructions.

## Code Style Guidelines

### Import Conventions

1. **Always use `.js` extensions** for local imports (TypeScript requirement for ES modules):

   ```typescript
   import { loadServerConfig } from "../shared/config.js"; // ✓ Correct
   import { loadServerConfig } from "../shared/config"; // ✗ Wrong
   ```

2. **Use package names for cross-package imports**:

   ```typescript
   import { loadServerConfig } from "@musicd/shared"; // ✓ Correct for imports from other packages
   import { MusicDaemonClient } from "@musicd/client"; // ✓ Correct
   import { JellyfinService } from "../services/jellyfin.js"; // ✓ Correct for same-package imports
   ```

3. **Import order** (separated by blank lines):

   ```typescript
   // 1. External dependencies
   import { Hono } from "hono";
   import { z } from "zod";

   // 2. Type-only imports from external deps
   import type { Context } from "hono";

   // 3. Internal imports from workspace packages
   import {
     loadServerConfig,
     JellyfinError,
     APP_VERSION,
   } from "@musicd/shared";
   import { MusicDaemonClient } from "@musicd/client";

   // 4. Same-package imports
   import { JellyfinService } from "./services/jellyfin.js";

   // 5. Type-only imports from internal modules
   import type { PlayRequest, ServerConfig } from "@musicd/shared";
   ```

4. **Use `type` imports** for type-only imports:
   ```typescript
   import type { JellyfinConfig } from "./types.js"; // ✓ Correct for types
   import { JellyfinError } from "./types.js"; // ✓ Correct for runtime values
   ```

### TypeScript Conventions

1. **Strict mode enabled** - All TypeScript strict checks are enforced
2. **Explicit return types** for public functions/methods
3. **Interface over type** for object shapes:

   ```typescript
   export interface Config {
     // ✓ Use interface
     jellyfin: JellyfinConfig;
   }

   export type PlaybackState = "playing" | "stopped"; // ✓ Use type for unions
   ```

4. **PascalCase** for interfaces, types, classes, and enums
5. **camelCase** for variables, functions, and methods
6. **UPPER_SNAKE_CASE** for constants:
   ```typescript
   export const DEFAULT_DAEMON_PORT = 8765;
   ```

### File Organization

```
packages/
├── shared/       # Shared types, config, utilities
│   └── src/
│       ├── types.ts      # Type definitions
│       ├── schemas.ts    # Zod validation schemas
│       ├── constants.ts  # Application constants
│       ├── config.ts     # Configuration loading
│       ├── token-storage.ts  # Auth token management
│       └── index.ts      # Public API exports
├── client/       # HTTP client for daemon API
│   └── src/
│       ├── index.ts      # MusicDaemonClient class
│       └── types.ts      # Client-specific response types
├── server/       # HTTP daemon server
│   └── src/
│       ├── index.ts      # Server entry point
│       ├── api/
│       │   └── routes.ts # API route handlers
│       └── services/
│           ├── jellyfin.ts   # Jellyfin API service
│           └── player.ts     # Player service
└── cli/          # CLI tool
    └── src/
        ├── index.ts      # CLI entry point
        ├── setup.ts      # Setup wizard
        ├── select-with-quit.ts    # Interactive UI
        └── expandable-select.ts   # Interactive UI
```

### Error Handling

1. **Custom error classes** for different error types:

   ```typescript
   export class JellyfinError extends Error {
     constructor(
       message: string,
       public statusCode?: number,
     ) {
       super(message);
       this.name = "JellyfinError";
     }
   }
   ```

2. **Throw custom errors** with descriptive messages and status codes
3. **Catch and re-throw pattern** for service methods:

   ```typescript
   try {
     // API call
   } catch (error) {
     if (error instanceof JellyfinError) {
       throw error; // Re-throw custom errors
     }
     throw new JellyfinError(`Network error: ${error}`); // Wrap others
   }
   ```

4. **Handle errors in routes** with appropriate HTTP status codes:
   ```typescript
   if (error instanceof JellyfinError) {
     const statusCode = (error.statusCode || 500) as 500 | 404 | 400 | 401;
     return c.json({ success: false, error: error.message }, statusCode);
   }
   ```

### Validation

1. **Use Zod schemas** for input validation:

   ```typescript
   const PlayRequestSchema = z.object({
     itemId: z.string().min(1, "Item ID is required"),
   });

   const { itemId } = PlayRequestSchema.parse(body);
   ```

2. **Validate at API boundaries** (route handlers, CLI input)
3. **Return structured error responses** for validation failures

### Documentation

1. **JSDoc comments** for public methods and complex functions:

   ```typescript
   /**
    * Authenticate with Jellyfin server using username/password
    * This is typically only called during initial setup
    */
   async authenticate(username: string, password: string): Promise<AuthenticationResult> {
   ```

2. **Inline comments** for complex logic or non-obvious behavior
3. **No comments** for self-explanatory code

### Async/Await

1. **Prefer async/await** over promises and callbacks
2. **Always handle errors** in async functions with try/catch
3. **Use `await` with fetch** and other async operations

### Path Aliases

- Use `@/*` for absolute imports from `src/`:
  ```typescript
  import { Config } from "@/shared/types.js"; // Available if needed
  ```
- Currently, relative imports are preferred in the codebase

## Researching the Jellyfin API

When you need to understand or implement Jellyfin API features, follow this approach:

### 1. Use the OpenAPI Specification

The official Jellyfin API spec is available at:

```
https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
```

**How to use it:**

1. Fetch the full OpenAPI JSON spec:

```bash
curl -o jellyfin-api.json https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
```

2. Search for relevant endpoints and parameters using grep:

```bash
# Find endpoints related to search
grep -B 10 -A 80 '"/Search/Hints"' jellyfin-api.json

# Find all uses of a parameter like searchTerm
grep -B 5 -A 10 '"searchTerm"' jellyfin-api.json
```

3. Review the parameter descriptions, schemas, and response types in the spec

### 2. Reference the Source Code

For deeper understanding of how endpoints work, check the Jellyfin source on GitHub:

```
https://github.com/jellyfin/jellyfin
```

**Useful locations:**

- API Controllers: `Jellyfin.Api/Controllers/`
- Search implementation: `Jellyfin.Api/Controllers/SearchController.cs`

**How to use it:**

1. Find the raw source file:

```
https://raw.githubusercontent.com/jellyfin/jellyfin/master/Jellyfin.Api/Controllers/SearchController.cs
```

2. Review the implementation to understand:
   - What fields are actually searched
   - How parameters are processed
   - Any limitations or special behavior

### Example: Discovering Search Endpoints

When implementing search functionality, we discovered:

1. **`/Users/{userId}/Items?SearchTerm=`** - Only searches item names/titles
2. **`/Search/Hints`** - Better for broad search, searches across:
   - Track/song names
   - Album names
   - Artist names
   - Album artists

This was found by:

1. Fetching the OpenAPI spec
2. Grepping for search-related endpoints
3. Reviewing the `SearchController.cs` source code
4. Comparing the parameter descriptions and implementations

### 3. Don't Rely on Assumptions

- The Jellyfin API documentation at jellyfin.org/docs focuses on server setup, not API details
- Always verify endpoint behavior using the OpenAPI spec or source code
- Don't assume what fields are searched without checking the spec
