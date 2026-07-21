import { describe, expect, test } from "bun:test";

import { executeSetup } from "./setup";

import type { ResolvedDaemonConnection } from "@musicd/shared";

const localConnection: ResolvedDaemonConnection = {
  host: "127.0.0.1",
  port: 8765,
  protocol: "http",
  allowInsecureHttp: false,
};

describe("CLI setup flow", () => {
  test("accepts a custom Jellyfin URL and sends it through the daemon client", async () => {
    const authenticationRequests: unknown[][] = [];
    const result = await executeSetup(
      {
        connectionArgs: { profile: "local" },
        jellyfinServerUrl: "https://jellyfin.example",
      },
      {
        prompt: async () => "listener",
        promptPassword: async () => "jellyfin-password",
        resolveConnection: () => localConnection,
        createClient: () => ({
          baseUrl: "http://127.0.0.1:8765",
          client: {
            authenticate: async (...args: unknown[]) => {
              authenticationRequests.push(args);
              return {
                success: true,
                user: { id: "user-1", name: "Listener" },
              };
            },
          },
        }),
      },
    );

    expect(result.user.name).toBe("Listener");
    expect(authenticationRequests).toEqual([
      ["listener", "jellyfin-password", "https://jellyfin.example"],
    ]);
  });

  test("collects a Jellyfin URL when one is not supplied", async () => {
    const questions: string[] = [];
    const answers = ["http://jellyfin.lan:8096", "listener"];
    const authenticationRequests: unknown[][] = [];

    await executeSetup(
      {},
      {
        prompt: async (question) => {
          questions.push(question);
          return answers.shift() ?? "";
        },
        promptPassword: async () => "jellyfin-password",
        resolveConnection: () => localConnection,
        createClient: () => ({
          baseUrl: "http://127.0.0.1:8765",
          client: {
            authenticate: async (...args: unknown[]) => {
              authenticationRequests.push(args);
              return {
                success: true,
                user: { id: "user-1", name: "Listener" },
              };
            },
          },
        }),
      },
    );

    expect(questions[0]).toContain("Jellyfin Server URL");
    expect(authenticationRequests[0]).toEqual([
      "listener",
      "jellyfin-password",
      "http://jellyfin.lan:8096",
    ]);
  });
});
