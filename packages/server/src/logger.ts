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
      console.log("[debug]", ...args);
    }
  }

  /**
   * Log an info message (only prints when enabled)
   */
  info(...args: unknown[]): void {
    if (this.enabled) {
      console.log("[info]", ...args);
    }
  }

  /**
   * Log a warning message (only prints when enabled)
   */
  warn(...args: unknown[]): void {
    if (this.enabled) {
      console.log("[warn]", ...args);
    }
  }

  /**
   * Log an error message (only prints when enabled)
   */
  error(...args: unknown[]): void {
    if (this.enabled) {
      console.error("[error]", ...args);
    }
  }

  /**
   * Log HTTP request/response details (only prints when enabled)
   * Provides structured logging for API calls
   */
  http(
    type: "request" | "response",
    details: {
      method: string;
      url: string;
      status?: number;
      duration?: number;
      error?: string;
    },
  ): void {
    if (this.enabled) {
      if (type === "request") {
        console.log(`[http] --> ${details.method} ${details.url}`);
      } else {
        const statusEmoji =
          details.status && details.status >= 400 ? "❌" : "✓";
        const duration = details.duration ? ` (${details.duration}ms)` : "";
        const errorMsg = details.error ? ` - ${details.error}` : "";
        console.log(
          `[http] <-- ${details.method} ${details.url} ${details.status}${duration}${statusEmoji}${errorMsg}`,
        );
      }
    }
  }
}

// Singleton instance
export const logger = new Logger();
