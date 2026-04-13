const US_PER_SEC = 1_000_000;
const US_PER_MS = 1_000;

export function usToSeconds(us: number): number {
  return us / US_PER_SEC;
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

export function parseTimeInput(input: string): number {
  // "+0.5s", "-1s", "1.5s", "+500ms", "1:30", "0:05.5"
  const negative = input.startsWith("-");
  const clean = input.replace(/^[+-]/, "");

  if (clean.endsWith("ms")) {
    const val = parseFloat(clean.replace("ms", ""));
    return (negative ? -1 : 1) * Math.round(val * US_PER_MS);
  }
  if (clean.endsWith("s")) {
    const val = parseFloat(clean.replace("s", ""));
    return (negative ? -1 : 1) * secondsToUs(val);
  }
  if (clean.includes(":")) {
    const parts = clean.split(":");
    let totalSec = 0;
    if (parts.length === 3) {
      totalSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    } else {
      totalSec = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return (negative ? -1 : 1) * secondsToUs(totalSec);
  }
  // bare number = seconds
  const val = parseFloat(clean);
  if (isNaN(val)) throw new Error(`Invalid time: ${input}`);
  return (negative ? -1 : 1) * secondsToUs(val);
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
  const totalSec = us / US_PER_SEC;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const ms = Math.round((totalSec % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${ms.toString().padStart(3, "0")}`;
}
