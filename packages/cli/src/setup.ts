import { createInterface } from "readline";
import { stdin as input, stdout as output } from "process";

import {
  ConfigError,
  DEFAULT_JELLYFIN_URL,
  JellyfinConfigSchema,
  loadServerConfigIfPresent,
  resolveDaemonConnection,
} from "@musicd/shared";

import { createDaemonClient } from "./daemon-connection";

import type {
  CliConnectionArgs,
  ResolvedDaemonConnection,
} from "@musicd/shared";
import type { AuthResponse } from "@musicd/client";

/**
 * Prompt for user input
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for password (hidden input)
 */
function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });

    output.write(question);

    // Hide input for password
    if (input.isTTY) {
      input.setRawMode(true);
    }

    let password = "";

    input.on("data", (char) => {
      const c = char.toString("utf8");

      switch (c) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl-D
          if (input.isTTY) {
            input.setRawMode(false);
          }
          input.pause();
          output.write("\n");
          rl.close();
          resolve(password);
          break;
        case "\u0003": // Ctrl-C
          if (input.isTTY) {
            input.setRawMode(false);
          }
          process.exit(1);
          break;
        case "\u007f": // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            output.write("\b \b");
          }
          break;
        default:
          password += c;
          output.write("*");
          break;
      }
    });
  });
}

/**
 * Run the setup wizard
 * @param connectionArgs - Optional CLI connection args (--host, --port, --protocol, --password, --allow-insecure-http, --profile)
 */
export async function runSetup(
  connectionArgs?: CliConnectionArgs,
  jellyfinServerUrl?: string,
): Promise<void> {
  console.log("🎵 Jellyfin Music Daemon Setup\n");

  try {
    const result = await executeSetup({ connectionArgs, jellyfinServerUrl });

    console.log(`Jellyfin Server: ${result.serverUrl}`);
    console.log(`Daemon: ${result.daemonUrl}`);
    if (result.profileName) {
      console.log(`  (using profile: ${result.profileName})`);
    }
    console.log(`✓ Successfully authenticated as ${result.user.name}`);
    console.log("✓ Authentication token saved");
    console.log("\nSetup complete!");
  } catch (error) {
    console.error(
      "\n✗ Setup failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}

interface SetupDaemonClient {
  authenticate(
    username: string,
    password: string,
    serverUrl?: string,
  ): Promise<AuthResponse>;
}

interface SetupClientConnection {
  baseUrl: string;
  client: SetupDaemonClient;
}

export interface ExecuteSetupOptions {
  connectionArgs?: CliConnectionArgs;
  jellyfinServerUrl?: string;
}

export interface SetupDependencies {
  prompt: (question: string) => Promise<string>;
  promptPassword: (question: string) => Promise<string>;
  resolveConnection: (args: CliConnectionArgs) => ResolvedDaemonConnection;
  createClient: (connection: ResolvedDaemonConnection) => SetupClientConnection;
}

export interface SetupResult extends AuthResponse {
  daemonUrl: string;
  profileName?: string;
  serverUrl: string;
}

const DEFAULT_SETUP_DEPENDENCIES: SetupDependencies = {
  prompt,
  promptPassword,
  resolveConnection: resolveDaemonConnection,
  createClient: createDaemonClient,
};

/** Collect setup input and authenticate through the daemon API. */
export async function executeSetup(
  options: ExecuteSetupOptions,
  dependencies: SetupDependencies = DEFAULT_SETUP_DEPENDENCIES,
): Promise<SetupResult> {
  try {
    const existingConfig = loadServerConfigIfPresent();
    const defaultServerUrl =
      existingConfig?.jellyfin.serverUrl ?? DEFAULT_JELLYFIN_URL;
    const enteredServerUrl =
      options.jellyfinServerUrl ??
      (await dependencies.prompt(
        `Jellyfin Server URL [${defaultServerUrl}]: `,
      ));
    const serverUrl = enteredServerUrl.trim() || defaultServerUrl;
    const serverConfigResult = JellyfinConfigSchema.safeParse({ serverUrl });
    if (!serverConfigResult.success) {
      throw new ConfigError("Jellyfin server URL must be a valid URL");
    }

    const connection = dependencies.resolveConnection(
      options.connectionArgs ?? {},
    );
    const { baseUrl, client } = dependencies.createClient(connection);
    const username = await dependencies.prompt("Jellyfin Username: ");
    const password = await dependencies.promptPassword("Jellyfin Password: ");

    if (!username || !password) {
      throw new ConfigError("Username and password are required");
    }

    const result = await client.authenticate(
      username,
      password,
      serverConfigResult.data.serverUrl,
    );

    return {
      ...result,
      daemonUrl: baseUrl,
      profileName: connection.profileName,
      serverUrl: serverConfigResult.data.serverUrl,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new ConfigError(`Setup failed: ${String(error)}`);
  }
}
