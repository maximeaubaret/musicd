import { spawn } from "child_process";
import { YouTubeError, isYouTubeUrl } from "@musicd/shared";
import type { YouTubeQueueItem } from "@musicd/shared";
import { logger } from "../logger";

interface YtDlpJsonOutput {
  id: string;
  title: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  original_url: string;
  webpage_url: string;
}

export class YouTubeService {
  /**
   * Check if yt-dlp is installed and accessible
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await this.runYtDlp(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate that a string is a YouTube URL
   */
  static isYouTubeUrl(input: string): boolean {
    return isYouTubeUrl(input);
  }

  /**
   * Extract video ID from a YouTube URL
   */
  static extractVideoId(url: string): string | null {
    try {
      const parsed = new URL(url);

      // youtu.be/VIDEO_ID
      if (parsed.hostname === "youtu.be") {
        const id = parsed.pathname.slice(1);
        return id || null;
      }

      // youtube.com/watch?v=VIDEO_ID
      const vParam = parsed.searchParams.get("v");
      if (vParam) {
        return vParam;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get metadata for a YouTube video using yt-dlp --dump-json
   */
  async getVideoInfo(url: string): Promise<{
    id: string;
    title: string;
    artist: string | undefined;
    duration: number;
    youtubeUrl: string;
  }> {
    logger.debug(`YouTube: fetching video info for ${url}`);

    const output = await this.runYtDlp([
      "--dump-json",
      "--no-download",
      "--no-playlist",
      url,
    ]);

    const json: YtDlpJsonOutput = JSON.parse(output);

    return {
      id: json.id,
      title: json.title,
      artist: json.uploader || json.channel,
      duration: json.duration ?? 0,
      youtubeUrl: json.webpage_url || json.original_url || url,
    };
  }

  /**
   * Get the best audio stream URL for a YouTube video
   */
  async getStreamUrl(url: string): Promise<string> {
    logger.debug(`YouTube: extracting stream URL for ${url}`);

    const streamUrl = await this.runYtDlp([
      "-f",
      "bestaudio",
      "--get-url",
      "--no-download",
      "--no-playlist",
      url,
    ]);

    if (!streamUrl) {
      throw new YouTubeError("yt-dlp returned empty stream URL");
    }

    return streamUrl;
  }

  /**
   * Create a QueueItem from a YouTube URL
   */
  async createQueueItem(url: string): Promise<YouTubeQueueItem> {
    const info = await this.getVideoInfo(url);

    return {
      id: info.id,
      name: info.title,
      artist: info.artist,
      album: undefined,
      duration: info.duration,
      source: "youtube",
      youtubeUrl: info.youtubeUrl,
      videoId: info.id,
      uploader: info.artist,
    };
  }

  /**
   * Run yt-dlp with the given arguments
   * Handles timeouts, ENOENT, and error parsing
   */
  private async runYtDlp(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("yt-dlp", args);
      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new YouTubeError("yt-dlp timed out after 30 seconds"));
      }, 30000);

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(
            new YouTubeError(
              `yt-dlp failed (exit ${code}): ${stderr.trim() || "Unknown error"}`,
            ),
          );
        }
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        if (
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          reject(
            new YouTubeError(
              "yt-dlp is not installed. Install it with: pip install yt-dlp",
            ),
          );
        } else {
          reject(new YouTubeError(`Failed to run yt-dlp: ${error.message}`));
        }
      });
    });
  }
}
