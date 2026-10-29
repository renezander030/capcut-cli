const US_PER_SEC = 1_000_000;
const US_PER_MS = 1_000;
const DEFAULT_FPS = 30;

function frameRate(fps?: number): number {
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

function framesAtRate(us: number, rate: number): number {
  const frames = Math.round((us / US_PER_SEC) * rate);
  // Math.round returns -0 for small negative inputs; return a plain 0 so callers
  // comparing with Object.is semantics (node:assert/strict) do not trip over it.
  if (frames === 0) return us > 0 ? 1 : 0;
  return frames;
}

/** Positive durations use at least one frame; negative durations keep their signed rounding. */
export function framesFor(us: number, fps?: number): number {
  return framesAtRate(us, frameRate(fps));
}

/** Quantize to the nearest frame without collapsing a positive duration to zero. */
export function quantizeToFrame(us: number, fps?: number): number {
  const rate = frameRate(fps);
  return Math.round((framesAtRate(us, rate) * US_PER_SEC) / rate);
}

export function secondsToUs(s: number): number {
  return Math.round(s * US_PER_SEC);
}

export function formatTime(us: number): string {
  const totalSec = us / US_PER_SEC;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

export function formatDuration(us: number): string {
  const s = us / US_PER_SEC;
  if (s < 1) return `${(us / US_PER_MS).toFixed(0)}ms`;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toFixed(1)}s`;
}

/** A complete decimal time, rounded once to safe integer microseconds. */
export function parseTimeInput(input: string): number {
  // Decimal seconds (bare or s), milliseconds, M:SS and H:MM:SS. Clock
  // fields retain their existing unrestricted ranges; only the shape is strict.
  const scalar = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(ms|s)?$/.exec(input);
  const clock = /^([+-]?)(\d+):(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(input);
  let sign: string;
  let magnitude: number;
  if (scalar && scalar[0] === input) {
    sign = scalar[1];
    magnitude = Number(scalar[2]) * (scalar[3] === "ms" ? US_PER_MS : US_PER_SEC);
  } else if (clock && clock[0] === input) {
    sign = clock[1];
    const first = Number(clock[2]);
    const seconds =
      clock[3] === undefined ? first * 60 + Number(clock[4]) : first * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
    magnitude = seconds * US_PER_SEC;
  } else {
    throw new Error(`Invalid time: ${input}`);
  }
  const microseconds = Math.round(magnitude);
  if (!Number.isSafeInteger(microseconds))
    throw new Error(`Invalid time: ${input} (microseconds exceed the safe range)`);
  return sign === "-" ? -microseconds : microseconds;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad2(n: number): string {
  const whole = Math.floor(n);
  const frac = n - whole;
  if (frac === 0) return whole.toString().padStart(2, "0");
  return (whole + frac).toFixed(2).padStart(5, "0");
}

export function srtTime(us: number): string {
  // Round to whole milliseconds FIRST so a fraction >= 999.5ms carries into
  // seconds/minutes/hours instead of rendering an invalid ",1000" field.
  const totalMs = Math.round(us / US_PER_MS);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${ms.toString().padStart(3, "0")}`;
}

// WebVTT uses '.' as the millisecond separator.
export function vttTime(us: number): string {
  return srtTime(us).replace(",", ".");
}
