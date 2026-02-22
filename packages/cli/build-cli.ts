#!/usr/bin/env bun
/**
 * Build script for creating a single executable with git commit version
 */
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CONSTANTS_SRC_PATH = join(import.meta.dir, "../shared/src/constants.ts");
const OUTPUT_PATH = join(import.meta.dir, "../../bin/musicd");

async function main() {
  try {
    // Get git commit hash
    const gitCommit = await $`git rev-parse --short HEAD`.text();
    const hash = gitCommit.trim();

    // Get current date/time in yymmddhhmm format
    const now = new Date();
    const yy = now.getFullYear().toString().slice(-2);
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const hh = now.getHours().toString().padStart(2, "0");
    const min = now.getMinutes().toString().padStart(2, "0");
    const timestamp = `${yy}${mm}${dd}${hh}${min}`;

    const version = `${hash} - ${timestamp}`;

    console.log(`Building musicd CLI v${version}...`);

    // Backup and modify constants file
    const originalContent = readFileSync(CONSTANTS_SRC_PATH, "utf-8");
    const modifiedContent = originalContent.replace(
      /export const APP_VERSION = "[^"]*";/,
      `export const APP_VERSION = "${version}";`,
    );

    writeFileSync(CONSTANTS_SRC_PATH, modifiedContent);
    console.log(`✓ Updated APP_VERSION to ${version}`);

    try {
      // Create bin directory
      await $`mkdir -p ../../bin`;

      // Build x64 executable
      await $`bun build --compile --target=bun-linux-x64 --minify --sourcemap ./src/index.ts --outfile ${OUTPUT_PATH}-x64`;
      console.log(`✓ Built x64 executable: ${OUTPUT_PATH}-x64`);

      // Build ARM64 executable
      await $`bun build --compile --target=bun-linux-arm64 --minify --sourcemap ./src/index.ts --outfile ${OUTPUT_PATH}-arm64`;
      console.log(`✓ Built ARM64 executable: ${OUTPUT_PATH}-arm64`);

      console.log(`✓ Version: ${version}`);
    } finally {
      // Restore original file
      writeFileSync(CONSTANTS_SRC_PATH, originalContent);
      console.log(`✓ Restored original APP_VERSION`);
    }
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

main();
