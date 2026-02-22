import { createInterface } from "readline";
import { stdin as input, stdout as output } from "process";
import { MusicDaemonClient } from "@musicd/client";
import {
  loadServerConfig,
  resolveDaemonConnection,
  getServerConfigPath,
  clearAuth,
} from "@musicd/shared";
import type { CliConnectionArgs } from "@musicd/shared";

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
 * @param connectionArgs - Optional CLI connection args (--host, --port, --password, --profile)
 */
export async function runSetup(
  connectionArgs?: CliConnectionArgs,
): Promise<void> {
  console.log("🎵 Jellyfin Music Daemon Setup\n");

  try {
    // Load server configuration for Jellyfin server URL
    const serverConfig = loadServerConfig();

    // Resolve daemon connection (uses CLI args, then profile, then defaults)
    const connection = resolveDaemonConnection(connectionArgs || {});

    console.log(`Jellyfin Server: ${serverConfig.jellyfin.serverUrl}`);
    console.log(`(Edit ${getServerConfigPath()} to change server URL)\n`);

    console.log(`Daemon: http://${connection.host}:${connection.port}`);
    if (connection.profileName) {
      console.log(`  (using profile: ${connection.profileName})`);
    }
    console.log("");

    // Prompt for credentials
    const username = await prompt("Jellyfin Username: ");
    const password = await promptPassword("Jellyfin Password: ");

    if (!username || !password) {
      console.error("\n✗ Username and password are required");
      process.exit(1);
    }

    console.log("\nAuthenticating...");

    // Create client and authenticate via daemon
    const daemonUrl = `http://${connection.host}:${connection.port}`;
    const client = new MusicDaemonClient(daemonUrl, connection.password);
    const result = await client.authenticate(username, password);

    console.log(`✓ Successfully authenticated as ${result.user.name}`);
    console.log("✓ Authentication token saved");
    console.log("\nSetup complete!");
  } catch (error) {
    console.error(
      "\n✗ Setup failed:",
      error instanceof Error ? error.message : error,
    );
    // Clear any partial auth data
    clearAuth();
    process.exit(1);
  }
}
