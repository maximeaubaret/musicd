import { createInterface } from "readline";
import { stdin as input, stdout as output } from "process";
import { JellyfinService } from "../server/services/jellyfin.js";
import { loadConfig } from "../shared/config.js";
import { hasAuth, clearAuth } from "../shared/token-storage.js";

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
 */
export async function runSetup(force: boolean = false): Promise<void> {
  console.log("🎵 Jellyfin Music Daemon Setup\n");

  // Check if already configured
  if (hasAuth() && !force) {
    const answer = await prompt(
      "Authentication is already configured. Do you want to reconfigure? (y/N): ",
    );
    if (answer.toLowerCase() !== "y") {
      console.log("Setup cancelled.");
      return;
    }
  }

  try {
    // Load configuration
    const config = loadConfig();

    console.log(`Jellyfin Server: ${config.jellyfin.serverUrl}`);
    console.log("(Edit .env or config/default.json to change server URL)\n");

    // Prompt for credentials
    const username = await prompt("Jellyfin Username: ");
    const password = await promptPassword("Jellyfin Password: ");

    if (!username || !password) {
      console.error("\n✗ Username and password are required");
      process.exit(1);
    }

    console.log("\nAuthenticating...");

    // Create service and authenticate
    const jellyfinService = new JellyfinService(config.jellyfin);
    const result = await jellyfinService.authenticate(username, password);

    console.log(`✓ Successfully authenticated as ${result.User.Name}`);
    console.log("✓ Authentication token saved\n");
    console.log(
      "Setup complete! You can now start the daemon with: bun run dev",
    );
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
