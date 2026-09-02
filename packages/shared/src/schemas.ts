import { z } from "zod";

import { SEARCH_TYPES } from "./types";

const CompleteIntegerStringSchema = z.string().regex(/^\d+$/).transform(Number);

export const PortStringSchema = CompleteIntegerStringSchema.pipe(
  z.number().int().min(1).max(65535),
);

export const QueueIndexStringSchema = CompleteIntegerStringSchema.pipe(
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
);

export const SearchLimitStringSchema = CompleteIntegerStringSchema.pipe(
  z.number().int().min(1).max(100),
);

/**
 * `?type=` on /api/search: a comma-separated subset of SEARCH_TYPES. Omitting
 * it searches all three. Duplicates collapse and the daemon's own type order is
 * restored, so the response order does not depend on how the caller spelled it.
 */
export const SearchTypesStringSchema = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.enum(SEARCH_TYPES)).nonempty())
  .transform((types) => SEARCH_TYPES.filter((type) => types.includes(type)));

// ============================================
// CLI Config Schemas
// ============================================

export const DaemonProtocolSchema = z.enum(["http", "https"]);

export const DaemonProfileSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535),
  protocol: DaemonProtocolSchema.optional(),
  password: z.string().optional(),
  allowInsecureHttp: z.boolean().optional(),
});

export const CliConfigSchema = z.object({
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), DaemonProfileSchema),
});

// ============================================
// Server Config Schemas
// ============================================

export const JellyfinConfigSchema = z.object({
  serverUrl: z.string().url("Must be a valid URL"),
});

export const AudioConfigSchema = z.object({
  device: z.string().optional(),
  backend: z.enum(["ffplay", "mpv"]).optional(),
});

export const ServerBindingConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8765),
  password: z.string().optional(),
});

export const StateConfigSchema = z.object({
  restoreQueue: z.boolean().default(true),
});

export const ServerConfigSchema = z.object({
  jellyfin: JellyfinConfigSchema,
  daemon: ServerBindingConfigSchema,
  audio: AudioConfigSchema.optional(),
  state: StateConfigSchema.optional(),
});
