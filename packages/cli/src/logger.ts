import chalk from "chalk";

/**
 * Simple logger that only prints when enabled
 * Use for debug/verbose output that shouldn't appear by default
 */
class Logger {
  private enabled = false;

  /**
   * Enable logging output
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable logging output
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Check if logging is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Log a debug message (only prints when enabled)
   */
  debug(...args: unknown[]): void {
    if (this.enabled) {
      console.log(chalk.gray("[debug]"), ...args);
    }
  }

  /**
   * Log an info message (only prints when enabled)
   */
  info(...args: unknown[]): void {
    if (this.enabled) {
      console.log(chalk.blue("[info]"), ...args);
    }
  }

  /**
   * Log a warning message (only prints when enabled)
   */
  warn(...args: unknown[]): void {
    if (this.enabled) {
      console.log(chalk.yellow("[warn]"), ...args);
    }
  }
}

// Singleton instance
export const logger = new Logger();
