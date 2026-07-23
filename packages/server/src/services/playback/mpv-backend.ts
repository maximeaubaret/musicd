import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createConnection } from "net";
import { tmpdir } from "os";
import { join } from "path";

import type { PlaybackBackend, PlaybackSource } from "./backend";
import { PlaybackError } from "./backend";
import { logger } from "../../logger";

const DEFAULT_IPC_CONNECT_TIMEOUT_MS = 5000;
const IPC_CONNECT_RETRY_INTERVAL_MS = 50;

/**
 * Build mpv arguments for a stream source.
 *
 * Headers are passed via --http-header-fields, which is visible in argv;
 * debug logging redacts them, matching the ffplay backend's behavior.
 */
export function getMpvArguments(
  source: PlaybackSource,
  socketPath: string,
  audioDevice: string,
): string[] {
  const args = [
    "--no-video",
    "--no-terminal",
    "--idle=no",
    "--keep-open=no",
    `--input-ipc-server=${socketPath}`,
  ];

  if (audioDevice !== "default") {
    args.push(`--ao=${audioDevice}`);
  }

  if (source.startPosition !== undefined && source.startPosition > 0) {
    args.push(`--start=${source.startPosition}`);
  }

  if (source.headers) {
    const serializedHeaders = Object.entries(source.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join(",");
    if (serializedHeaders.length > 0) {
      args.push(`--http-header-fields=${serializedHeaders}`);
    }
  }

  args.push(source.url);
  return args;
}

/**
 * Split a stream of IPC bytes into parsed JSON messages. mpv writes one JSON
 * object per line; chunks can split lines anywhere, so the remainder carries
 * over between calls.
 */
export class MpvMessageBuffer {
  private remainder = "";

  push(chunk: string): unknown[] {
    const data = this.remainder + chunk;
    const lines = data.split("\n");
    this.remainder = lines.pop() ?? "";

    const messages: unknown[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        logger.debug(`[mpv] Ignoring unparseable IPC line: ${trimmed}`);
      }
    }
    return messages;
  }
}

export interface MpvIpc {
  send(command: unknown[]): void;
  onMessage(callback: (message: unknown) => void): void;
  close(): void;
}

/**
 * Connect to mpv's IPC socket, retrying until mpv has created it.
 */
function connectIpcWithRetry(
  socketPath: string,
  timeoutMs: number,
): Promise<MpvIpc> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection(socketPath);
      const messageBuffer = new MpvMessageBuffer();
      const messageCallbacks: Array<(message: unknown) => void> = [];

      socket.on("connect", () => {
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          for (const message of messageBuffer.push(chunk)) {
            for (const callback of messageCallbacks) {
              callback(message);
            }
          }
        });
        resolve({
          send: (command) => {
            socket.write(JSON.stringify({ command }) + "\n");
          },
          onMessage: (callback) => {
            messageCallbacks.push(callback);
          },
          close: () => {
            socket.destroy();
          },
        });
      });

      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(
            new PlaybackError(
              `Timed out connecting to mpv IPC socket at ${socketPath}`,
            ),
          );
          return;
        }
        setTimeout(attempt, IPC_CONNECT_RETRY_INTERVAL_MS);
      });
    };

    attempt();
  });
}

interface MpvBackendDependencies {
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  connectIpc: (socketPath: string, timeoutMs: number) => Promise<MpvIpc>;
  createSocketPath: () => string;
  ipcConnectTimeoutMs: number;
}

let socketSequence = 0;

/**
 * mpv playback backend. Unlike ffplay, mpv exposes a JSON IPC socket, which
 * gives us in-place seeking, real pause (not SIGSTOP), and an authoritative
 * media clock via property observation.
 */
export class MpvBackend implements PlaybackBackend {
  private process: ChildProcess | null = null;
  private ipc: MpvIpc | null = null;
  private audioDevice: string;
  private debug: boolean;
  private position = 0;
  private volume = 100;
  private isPaused_ = false;
  private manuallyStopped = false;
  private spawnProcess: MpvBackendDependencies["spawnProcess"];
  private connectIpc: MpvBackendDependencies["connectIpc"];
  private createSocketPath: MpvBackendDependencies["createSocketPath"];
  private ipcConnectTimeoutMs: number;
  private onCompleteCallback?: (position: number) => void | Promise<void>;
  private onErrorCallback?: (
    error: Error,
    position: number,
  ) => void | Promise<void>;

  constructor(
    audioDevice: string = "default",
    debug: boolean = false,
    dependencies: Partial<MpvBackendDependencies> = {},
  ) {
    this.audioDevice = audioDevice;
    this.debug = debug;
    this.spawnProcess =
      dependencies.spawnProcess ??
      ((command, args, options) => spawn(command, args, options));
    this.connectIpc = dependencies.connectIpc ?? connectIpcWithRetry;
    this.createSocketPath =
      dependencies.createSocketPath ??
      (() => join(tmpdir(), `musicd-mpv-${process.pid}-${++socketSequence}`));
    this.ipcConnectTimeoutMs =
      dependencies.ipcConnectTimeoutMs ?? DEFAULT_IPC_CONNECT_TIMEOUT_MS;
  }

  async play(source: PlaybackSource): Promise<void> {
    if (this.isPlaying()) {
      await this.stop();
    }

    const socketPath = this.createSocketPath();
    const args = getMpvArguments(source, socketPath, this.audioDevice);

    if (this.debug) {
      const loggedArgs = args.map((arg) =>
        arg.startsWith("--http-header-fields=")
          ? "--http-header-fields=<redacted>"
          : arg,
      );
      logger.debug(`[mpv] Starting playback: mpv ${loggedArgs.join(" ")}`);
    }

    const activeProcess = this.spawnProcess("mpv", args, {
      stdio: ["ignore", "ignore", this.debug ? "pipe" : "ignore"],
    });
    this.process = activeProcess;
    this.position = source.startPosition ?? 0;
    this.isPaused_ = false;
    this.manuallyStopped = false;
    let endFileHandled = false;

    if (this.debug && activeProcess.stderr) {
      activeProcess.stderr.on("data", (data: Buffer) => {
        logger.debug(`[mpv stderr] ${data.toString().trim()}`);
      });
    }

    activeProcess.on("error", (error) => {
      const wasManuallyStopped = this.manuallyStopped;
      const position = this.position;
      this.cleanup(activeProcess);
      if (!wasManuallyStopped && this.onErrorCallback) {
        void this.invokeTerminalCallback(
          () =>
            this.onErrorCallback!(
              new PlaybackError(`mpv process error: ${error.message}`),
              position,
            ),
          "error",
        );
      }
    });

    activeProcess.on("exit", (exitCode) => {
      const wasManuallyStopped = this.manuallyStopped;
      const position = this.position;
      this.cleanup(activeProcess);
      if (wasManuallyStopped || endFileHandled) {
        return;
      }
      // Exit without an observed end-file: eof if clean, error otherwise.
      if (exitCode === 0) {
        if (this.onCompleteCallback) {
          void this.invokeTerminalCallback(
            () => this.onCompleteCallback!(position),
            "completion",
          );
        }
        endFileHandled = true;
        return;
      }
      if (this.onErrorCallback) {
        void this.invokeTerminalCallback(
          () =>
            this.onErrorCallback!(
              new PlaybackError(
                exitCode === null
                  ? "mpv exited without an exit code"
                  : `mpv exited with code ${exitCode}`,
              ),
              position,
            ),
          "error",
        );
      }
    });

    try {
      const ipc = await this.connectIpc(socketPath, this.ipcConnectTimeoutMs);
      if (this.process !== activeProcess) {
        // A newer play/stop superseded us while connecting.
        ipc.close();
        return;
      }
      this.ipc = ipc;

      ipc.onMessage((message) => {
        if (this.process !== activeProcess) {
          return;
        }
        const event = message as {
          event?: string;
          name?: string;
          data?: unknown;
          reason?: string;
        };

        if (
          event.event === "property-change" &&
          event.name === "time-pos" &&
          typeof event.data === "number" &&
          Number.isFinite(event.data)
        ) {
          this.position = Math.max(0, event.data);
          return;
        }

        if (event.event === "end-file") {
          const reason = event.reason ?? "";
          if (reason === "eof") {
            endFileHandled = true;
            const position = this.position;
            if (this.onCompleteCallback) {
              void this.invokeTerminalCallback(
                () => this.onCompleteCallback!(position),
                "completion",
              );
            }
          } else if (reason === "error") {
            endFileHandled = true;
            const position = this.position;
            if (!this.manuallyStopped && this.onErrorCallback) {
              void this.invokeTerminalCallback(
                () =>
                  this.onErrorCallback!(
                    new PlaybackError("mpv failed to play the stream"),
                    position,
                  ),
                "error",
              );
            }
          }
          // "quit" / "stop" are manual outcomes; the exit handler stays quiet
          // because manuallyStopped is set before we ask mpv to quit.
        }
      });

      ipc.send(["observe_property", 1, "time-pos"]);
      ipc.send(["set_property", "volume", this.volume]);
    } catch (error) {
      if (this.process === activeProcess) {
        this.manuallyStopped = true;
        activeProcess.kill("SIGKILL");
        this.cleanup(activeProcess);
      }
      throw error instanceof PlaybackError
        ? error
        : new PlaybackError(`Failed to connect to mpv IPC: ${error}`);
    }
  }

  pause(): void {
    if (!this.isPlaying() || this.isPaused_ || !this.ipc) {
      return;
    }
    this.ipc.send(["set_property", "pause", true]);
    this.isPaused_ = true;
  }

  resume(): void {
    if (!this.isPaused_ || !this.ipc) {
      return;
    }
    this.ipc.send(["set_property", "pause", false]);
    this.isPaused_ = false;
  }

  /**
   * In-place absolute seek over IPC. Pause state is preserved by mpv.
   */
  async seek(positionSeconds: number): Promise<void> {
    if (!this.isPlaying() || !this.ipc) {
      throw new PlaybackError("Cannot seek: nothing is playing");
    }
    const target = Math.max(0, positionSeconds);
    this.ipc.send(["seek", target, "absolute"]);
    // Optimistic; the next time-pos property event corrects any clamping.
    this.position = target;
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(volumePercent: number): void {
    this.volume = Math.max(0, Math.min(100, volumePercent));
    if (this.ipc && this.isPlaying()) {
      this.ipc.send(["set_property", "volume", this.volume]);
    }
  }

  async stop(): Promise<void> {
    if (!this.isPlaying()) {
      return;
    }

    const processToStop = this.process!;
    this.manuallyStopped = true;

    try {
      processToStop.removeAllListeners();
      if (this.ipc) {
        this.ipc.send(["quit"]);
      }
      processToStop.kill("SIGTERM");

      await new Promise((resolve) => {
        processToStop.on("exit", resolve);
        setTimeout(() => {
          if (processToStop.exitCode === null) {
            processToStop.kill("SIGKILL");
          }
          resolve(null);
        }, 2000);
      });
    } finally {
      this.cleanup(processToStop);
    }
  }

  isPlaying(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  isPaused(): boolean {
    return this.isPaused_;
  }

  getPosition(): number {
    if (!this.process) {
      return 0;
    }
    return this.position;
  }

  onComplete(callback: (position: number) => void | Promise<void>): void {
    this.onCompleteCallback = callback;
  }

  onError(
    callback: (error: Error, position: number) => void | Promise<void>,
  ): void {
    this.onErrorCallback = callback;
  }

  private async invokeTerminalCallback(
    callback: () => void | Promise<void>,
    eventName: "completion" | "error",
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      logger.error(`[mpv] ${eventName} callback failed:`, error);
    }
  }

  private cleanup(processToClean: ChildProcess): void {
    if (this.process !== processToClean) {
      return;
    }
    if (this.ipc) {
      this.ipc.close();
      this.ipc = null;
    }
    this.process = null;
    this.position = 0;
    this.isPaused_ = false;
    this.manuallyStopped = false;
  }
}
