import { Hono } from "hono";

import { createApiRoutes, createAuthMiddleware } from "./api/routes";

import type {
  ApiClock,
  ApiJellyfinService,
  ApiPlayerService,
  ApiYouTubeService,
} from "./api/routes";

export interface CreateAppOptions {
  jellyfinService: ApiJellyfinService;
  youtubeService: ApiYouTubeService;
  playerService: ApiPlayerService;
  clock?: ApiClock;
  startTime: number;
  daemonPassword?: string;
  ytDlpAvailable?: boolean;
}

/**
 * Construct the HTTP application without starting a network listener.
 */
export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();

  app.route(
    "/api",
    createApiRoutes(
      options.jellyfinService,
      options.youtubeService,
      options.playerService,
      options.startTime,
      options.daemonPassword,
      options.ytDlpAvailable,
      options.clock,
    ),
  );

  app.use("/", createAuthMiddleware(options.daemonPassword));
  app.get("/", (c) => {
    return c.json({
      name: "Jellyfin Music Daemon",
      version: "0.1.0",
      status: "running",
    });
  });

  return app;
}
