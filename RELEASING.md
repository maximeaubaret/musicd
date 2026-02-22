# Releasing

Releases are automated via GitHub Actions when a version tag is pushed.

## Steps

1. Update the version in `packages/shared/src/constants.ts` (optional - CI overrides it):

   ```typescript
   export const APP_VERSION = "1.0.0";
   ```

2. Commit any final changes:

   ```bash
   git add -A
   git commit -m "chore: prepare release v1.0.0"
   ```

3. Create and push a version tag:

   ```bash
   git tag v1.0.0
   git push origin main --tags
   ```

4. GitHub Actions will automatically:
   - Build CLI and server binaries for Linux x64 and ARM64
   - Create a GitHub release with the binaries
   - Generate release notes from commits

## Artifacts

Each release includes:

| File                        | Description             |
| --------------------------- | ----------------------- |
| `musicd-linux-x64`          | CLI for x64             |
| `musicd-linux-arm64`        | CLI for ARM64           |
| `musicd-server-linux-x64`   | Server daemon for x64   |
| `musicd-server-linux-arm64` | Server daemon for ARM64 |

## Versioning

Use [semantic versioning](https://semver.org/):

- `v1.0.0` - First stable release
- `v1.1.0` - New features, backward compatible
- `v1.0.1` - Bug fixes only
- `v2.0.0` - Breaking changes
