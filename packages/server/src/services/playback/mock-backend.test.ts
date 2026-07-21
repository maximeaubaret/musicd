import { describe, expect, test } from "bun:test";

import { MockBackend } from "./mock-backend";

describe("MockBackend", () => {
  test("natural completion exposes the final position after playback stops", async () => {
    const backend = new MockBackend();
    let completedAt: number | undefined;
    backend.onComplete((position) => {
      completedAt = position;
    });
    await backend.play({ url: "https://example.test/audio" });
    backend.setPosition(37);

    await backend.simulateComplete();

    expect(backend.isPlaying()).toBe(false);
    expect(backend.isPaused()).toBe(false);
    expect(backend.getPosition()).toBe(37);
    expect(completedAt).toBe(37);
  });

  test("backend errors expose the stopped state and last position", async () => {
    const backend = new MockBackend();
    let failedAt: number | undefined;
    backend.onError((_error, position) => {
      failedAt = position;
    });
    await backend.play({ url: "https://example.test/audio" });
    backend.setPosition(19);

    await backend.simulateError(new Error("decoder failed"));

    expect(backend.isPlaying()).toBe(false);
    expect(backend.isPaused()).toBe(false);
    expect(backend.getPosition()).toBe(19);
    expect(failedAt).toBe(19);
  });

  test("emits only the first terminal event for a playback", async () => {
    const backend = new MockBackend();
    const terminalEvents: string[] = [];
    backend.onComplete(() => {
      terminalEvents.push("complete");
    });
    backend.onError(() => {
      terminalEvents.push("error");
    });
    await backend.play({ url: "https://example.test/audio" });

    await backend.simulateError(new Error("decoder failed"));
    await backend.simulateComplete();

    expect(terminalEvents).toEqual(["error"]);
  });
});
