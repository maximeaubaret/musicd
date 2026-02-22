import { z } from "zod";

// ============================================
// CLI Config Schemas
// ============================================

export const DaemonProfileSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535),
  password: z.string().optional(),
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
});

export const ServerBindingConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8765),
  password: z.string().optional(),
});

export const ServerConfigSchema = z.object({
  jellyfin: JellyfinConfigSchema,
  daemon: ServerBindingConfigSchema,
  audio: AudioConfigSchema.optional(),
});
