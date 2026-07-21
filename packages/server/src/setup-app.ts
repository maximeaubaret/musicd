import { Hono } from "hono";
import { z } from "zod";

import {
  APP_VERSION,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  JellyfinError,
  ServerConfigSchema,
} from "@musicd/shared";

import type {
  AuthenticationResult,
  JellyfinConfig,
  ServerConfig,
} from "@musicd/shared";
import type { ApiClock } from "./api/routes";

const SetupRequestSchema = z.object({
  serverUrl: z.string().url("Must be a valid URL"),
  username: z.string().min(1),
  password: z.string().min(1),
});

export type SetupAuthenticator = (
  config: JellyfinConfig,
  username: string,
  password: string,
) => Promise<AuthenticationResult>;

export type SetupPersister = (
  config: ServerConfig,
  result: AuthenticationResult,
  username: string,
) => void;

export interface CreateSetupAppOptions {
  authenticate: SetupAuthenticator;
  persist: SetupPersister;
  startTime: number;
  clock?: ApiClock;
  existingConfig?: ServerConfig | null;
}

const SYSTEM_CLOCK: ApiClock = {
  now: () => Date.now(),
};

/** Construct the loopback-only setup API without normal daemon routes. */
export function createSetupApp(options: CreateSetupAppOptions): Hono {
  const app = new Hono();
  const clock = options.clock ?? SYSTEM_CLOCK;

  app.get("/api/health", (c) => {
    const uptime = Math.floor((clock.now() - options.startTime) / 1000);
    return c.json({
      success: true,
      status: "healthy",
      uptime,
      version: APP_VERSION,
    });
  });

  app.post("/api/auth", async (c) => {
    try {
      const body = (await c.req.json()) as unknown;
      const { serverUrl, username, password } = SetupRequestSchema.parse(body);
      const config = ServerConfigSchema.parse({
        ...(options.existingConfig ?? {
          daemon: {
            host: DEFAULT_DAEMON_HOST,
            port: DEFAULT_DAEMON_PORT,
          },
        }),
        jellyfin: { serverUrl },
      });
      const result = await options.authenticate(
        config.jellyfin,
        username,
        password,
      );

      options.persist(config, result, username);

      return c.json({
        success: true,
        user: {
          id: result.User.Id,
          name: result.User.Name,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ success: false, error: "Invalid setup request" }, 400);
      }
      if (error instanceof JellyfinError) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        return c.json({ success: false, error: error.message }, statusCode);
      }
      return c.json({ success: false, error: "Setup failed" }, 500);
    }
  });

  return app;
}
