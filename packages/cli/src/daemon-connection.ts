import chalk from "chalk";

import { MusicDaemonClient } from "@musicd/client";

import type { ResolvedDaemonConnection } from "@musicd/shared";

export interface ResolvedDaemonClient {
  baseUrl: string;
  client: MusicDaemonClient;
}

function formatDaemonHost(host: string): string {
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    return `[${host}]`;
  }
  return host;
}

/**
 * Create a daemon client from resolved CLI settings and surface insecure use.
 */
export function createDaemonClient(
  connection: ResolvedDaemonConnection,
): ResolvedDaemonClient {
  const baseUrl = `${connection.protocol}://${formatDaemonHost(connection.host)}:${connection.port}`;

  if (
    connection.protocol === "http" &&
    connection.password &&
    connection.allowInsecureHttp
  ) {
    console.warn(
      chalk.yellow(
        "⚠ Insecure HTTP override enabled: daemon password will be sent without transport encryption.",
      ),
    );
  }

  return {
    baseUrl,
    client: new MusicDaemonClient(baseUrl, connection.password, {
      allowInsecureHttp: connection.allowInsecureHttp,
    }),
  };
}
