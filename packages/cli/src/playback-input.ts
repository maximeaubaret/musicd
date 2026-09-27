import { InvalidArgumentError } from "commander";

/**
 * A value typed at the CLI: either an absolute target, or a signed offset
 * from the daemon's current value (`+10`, `-5`).
 */
export type PlaybackAdjustment =
  | { kind: "set"; value: number }
  | { kind: "adjust"; delta: number };

// Seconds ("90") or a clock time whose trailing fields are two-digit and
// below 60 ("1:30", "1:02:03"), with an optional sign for relative offsets.
const SEEK_ERROR = "Position must be seconds or [h:]m:ss";

const SEEK_PATTERN = /^([+-]?)(?:(\d+):)?(?:(\d+):)?(\d+)$/;
const VOLUME_PATTERN = /^([+-]?)(\d+)$/;
const QUEUE_POSITION_PATTERN = /^\d+$/;

function toAdjustment(sign: string, magnitude: number): PlaybackAdjustment {
  if (sign === "") {
    return { kind: "set", value: magnitude };
  }
  return { kind: "adjust", delta: sign === "-" ? -magnitude : magnitude };
}

/** Parse a seek target: seconds or [h:]m:ss, signed for a relative seek. */
export function parseSeekPosition(value: string): PlaybackAdjustment {
  const match = SEEK_PATTERN.exec(value);
  if (!match) {
    throw new InvalidArgumentError(SEEK_ERROR);
  }

  const [, sign, first, second, last] = match;
  const fields = [first, second, last].filter(
    (field): field is string => field !== undefined,
  );
  const trailing = fields.slice(1);
  if (trailing.some((field) => field.length !== 2 || Number(field) >= 60)) {
    throw new InvalidArgumentError(SEEK_ERROR);
  }

  const seconds = fields.reduce(
    (total, field) => total * 60 + Number(field),
    0,
  );
  return toAdjustment(sign, seconds);
}

/** Parse a volume level 0-100, or a signed adjustment. */
export function parseVolumeLevel(value: string): PlaybackAdjustment {
  const match = VOLUME_PATTERN.exec(value);
  if (!match || Number(match[2]) > 100) {
    throw new InvalidArgumentError("Volume must be 0-100, or +N/-N to adjust");
  }
  return toAdjustment(match[1], Number(match[2]));
}

/** Parse a 1-based queue position, as shown by `queue`, into a queue index. */
export function parseQueuePosition(value: string): number {
  const position = Number(value);
  if (!QUEUE_POSITION_PATTERN.test(value) || position < 1) {
    throw new InvalidArgumentError("Position must be a positive integer");
  }
  return position - 1;
}

/** Resolve an adjustment against the current value, clamped to [0, max]. */
export function applyAdjustment(
  adjustment: PlaybackAdjustment,
  current: number,
  max = Infinity,
): number {
  if (adjustment.kind === "set") {
    return adjustment.value;
  }
  return Math.min(max, Math.max(0, current + adjustment.delta));
}
