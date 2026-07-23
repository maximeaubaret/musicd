import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { ChildProcess } from "child_process";

import { PlaybackError } from "./backend";
import { getMpvArguments, MpvBackend, MpvMessageBuffer } from "./mpv-backend";
import type { MpvIpc } from "./mpv-backend";

describe("getMpvArguments", () => {
  test("builds baseline arguments with the socket and url", () => {
    const args = getMpvArguments(
      { url: "http://jellyfin.local/stream" },
      "/tmp/mpv.sock",
      "default",
    );

    expect(args).toEqual([
      "--no-video",
      "--no-terminal",
      "--idle=no",
      "--keep-open=no",
      "--input-ipc-server=/tmp/mpv.sock",
      "http://jellyfin.local/stream",
    ]);
  });

  test("includes audio output, start position, and headers when set", () => {
    const args = getMpvArguments(
      {
        url: "http://jellyfin.local/stream",
        headers: { "X-MediaBrowser-Token": "token-1" },
        startPosition: 42.5,
      },
      "/tmp/mpv.sock",
      "pulse",
    );

    expect(args).toContain("--ao=pulse");
    expect(args).toContain("--start=42.5");
    expect(args).toContain(
      "--http-header-fields=X-MediaBrowser-Token: token-1",
    );
    expect(args[args.length - 1]).toBe("http://jellyfin.local/stream");
  });

  test("omits a zero start position", () => {
    const args = getMpvArguments(
      { url: "http://jellyfin.local/stream", startPosition: 0 },
      "/tmp/mpv.sock",
      "default",
    );

    expect(args.some((arg) => arg.startsWith("--start="))).toBe(false);
  });
});

describe("MpvMessageBuffer", () => {
  test("parses complete lines and carries partial lines across chunks", () => {
    const buffer = new MpvMessageBuffer();

    const first = buffer.push('{"event":"end-file","reason":"eo');
    expect(first).toEqual([]);

    const second = buffer.push('f"}\n{"event":"property-change"}\n{"eve');
    expect(second).toEqual([
      { event: "end-file", reason: "eof" },
      { event: "property-change" },
    ]);

    const third = buffer.push('nt":"idle"}\n');
    expect(third).toEqual([{ event: "idle" }]);
  });

  test("skips blank and unparseable lines", () => {
    const buffer = new MpvMessageBuffer();

    const messages = buffer.push('\nnot-json\n{"event":"idle"}\n');

    expect(messages).toEqual([{ event: "idle" }]);
  });
});

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  killed: string[] = [];
  stderr = null;
  stdout = null;

  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }

  simulateExit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

class FakeIpc implements MpvIpc {
  sent: unknown[][] = [];
  closed = false;
  private callbacks: Array<(message: unknown) => void> = [];

  send(command: unknown[]): void {
    this.sent.push(command);
  }

  onMessage(callback: (message: unknown) => void): void {
    this.callbacks.push(callback);
  }

  close(): void {
    this.closed = true;
  }

  emit(message: unknown): void {
    for (const callback of this.callbacks) {
      callback(message);
    }
  }
}

function createBackend() {
  const process = new FakeProcess();
  const ipc = new FakeIpc();
  const spawnProcess = mock(() => process as unknown as ChildProcess);
  const backend = new MpvBackend("default", false, {
    spawnProcess,
    connectIpc: async () => ipc,
    createSocketPath: () => "/tmp/mpv-test.sock",
  });
  return { backend, process, ipc, spawnProcess };
}

describe("MpvBackend", () => {
  test("play spawns mpv, observes the media clock, and tracks position", async () => {
    const { backend, ipc, spawnProcess } = createBackend();

    await backend.play({ url: "http://jellyfin.local/stream" });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(backend.isPlaying()).toBe(true);
    expect(ipc.sent).toEqual([
      ["observe_property", 1, "time-pos"],
      ["set_property", "volume", 100],
    ]);

    ipc.emit({ event: "property-change", name: "time-pos", data: 12.25 });
    expect(backend.getPosition()).toBe(12.25);
  });

  test("natural end-of-file fires onComplete with the final position", async () => {
    const { backend, ipc, process } = createBackend();
    const positions: number[] = [];
    backend.onComplete((position) => {
      positions.push(position);
    });

    await backend.play({ url: "http://jellyfin.local/stream" });
    ipc.emit({ event: "property-change", name: "time-pos", data: 180.5 });
    ipc.emit({ event: "end-file", reason: "eof" });
    process.simulateExit(0);

    expect(positions).toEqual([180.5]);
  });

  test("manual stop suppresses completion and error callbacks", async () => {
    const { backend, ipc } = createBackend();
    const completions = mock(() => {});
    const errors = mock(() => {});
    backend.onComplete(completions);
    backend.onError(errors);

    await backend.play({ url: "http://jellyfin.local/stream" });
    await backend.stop();

    expect(ipc.sent).toContainEqual(["quit"]);
    expect(ipc.closed).toBe(true);
    expect(backend.isPlaying()).toBe(false);
    expect(completions).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  test("seek sends an absolute seek and updates the position optimistically", async () => {
    const { backend, ipc } = createBackend();

    await backend.play({ url: "http://jellyfin.local/stream" });
    await backend.seek(95);

    expect(ipc.sent).toContainEqual(["seek", 95, "absolute"]);
    expect(backend.getPosition()).toBe(95);
  });

  test("seek rejects when nothing is playing", async () => {
    const { backend } = createBackend();

    await expect(backend.seek(10)).rejects.toThrow(PlaybackError);
  });

  test("pause and resume toggle mpv's pause property", async () => {
    const { backend, ipc } = createBackend();

    await backend.play({ url: "http://jellyfin.local/stream" });
    backend.pause();
    expect(backend.isPaused()).toBe(true);
    backend.resume();
    expect(backend.isPaused()).toBe(false);

    expect(ipc.sent).toContainEqual(["set_property", "pause", true]);
    expect(ipc.sent).toContainEqual(["set_property", "pause", false]);
  });

  test("retains volume while stopped and applies it to playback", async () => {
    const { backend, ipc } = createBackend();

    backend.setVolume(37);
    expect(backend.getVolume()).toBe(37);

    await backend.play({ url: "http://jellyfin.local/stream" });
    expect(ipc.sent).toContainEqual(["set_property", "volume", 37]);

    backend.setVolume(62);
    expect(backend.getVolume()).toBe(62);
    expect(ipc.sent).toContainEqual(["set_property", "volume", 62]);
  });

  test("a crash surfaces through onError with the last position", async () => {
    const { backend, ipc, process } = createBackend();
    const errors: Array<[string, number]> = [];
    backend.onError((error, position) => {
      errors.push([error.message, position]);
    });

    await backend.play({ url: "http://jellyfin.local/stream" });
    ipc.emit({ event: "property-change", name: "time-pos", data: 33 });
    process.simulateExit(2);

    expect(errors).toEqual([["mpv exited with code 2", 33]]);
  });

  test("start position seeds the reported position before playback events", async () => {
    const { backend } = createBackend();

    await backend.play({
      url: "http://jellyfin.local/stream",
      startPosition: 60,
    });

    expect(backend.getPosition()).toBe(60);
  });
});
