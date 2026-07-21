import { isCredentialKey } from "@musicd/shared";

/**
 * Simple logger that only prints when enabled
 * Use for debug/verbose output that shouldn't appear by default
 */
function redactSensitiveText(value: string): string {
  return value
    .replace(
      /([?&])([^=&#\s]+)=([^&#\s]*)/g,
      (match, separator: string, key: string) =>
        isCredentialKey(key) ? `${separator}${key}=***` : match,
    )
    .replace(
      /((?:authorization|x-(?:emby|mediabrowser)-token)\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi,
      "$1***",
    )
    .replace(
      /(["']?)([a-z][a-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^"',;\s}&]+)/gi,
      (match, quote: string, key: string, separator: string) =>
        isCredentialKey(key) ? `${quote}${key}${separator}***` : match,
    )
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1***");
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (value instanceof Error) {
    const redactedError = new Error(redactSensitiveText(value.message));
    redactedError.name = value.name;
    if (value.stack) {
      redactedError.stack = redactSensitiveText(value.stack);
    }
    return redactedError;
  }
  if (Array.isArray(value)) {
    return value.map(redactLogValue);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isCredentialKey(key) ? "***" : redactLogValue(nestedValue),
      ]),
    );
  }
  return value;
}

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
      console.log("[debug]", ...args.map(redactLogValue));
    }
  }

  /**
   * Log an info message (only prints when enabled)
   */
  info(...args: unknown[]): void {
    if (this.enabled) {
      console.log("[info]", ...args.map(redactLogValue));
    }
  }

  /**
   * Log a warning message (only prints when enabled)
   */
  warn(...args: unknown[]): void {
    if (this.enabled) {
      console.log("[warn]", ...args.map(redactLogValue));
    }
  }

  /**
   * Log an error message (only prints when enabled)
   */
  error(...args: unknown[]): void {
    if (this.enabled) {
      console.error("[error]", ...args.map(redactLogValue));
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
      const safeUrl = redactSensitiveText(details.url);
      if (type === "request") {
        console.log(`[http] --> ${details.method} ${safeUrl}`);
      } else {
        const statusEmoji =
          details.status && details.status >= 400 ? "❌" : "✓";
        const duration =
          details.duration !== undefined ? ` (${details.duration}ms)` : "";
        const errorMsg = details.error ? ` - ${details.error}` : "";
        console.log(
          redactSensitiveText(
            `[http] <-- ${details.method} ${safeUrl} ${details.status}${duration}${statusEmoji}${errorMsg}`,
          ),
        );
      }
    }
  }
}

// Singleton instance
export const logger = new Logger();
