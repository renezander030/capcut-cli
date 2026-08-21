import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Synthesize a voiceover through a user-provided local TTS command.
 *
 * Like caption's whisper integration, the engine is shell-out only: the user
 * supplies the command as a template with `{out}` (required — the audio file
 * the tool must write) and optionally `{text}`. The template is tokenized here
 * and run WITHOUT a shell — `{text}` lands as a single argv token, so spaces,
 * quotes, and metacharacters in the script are inert (the 0.17.1 injection
 * class). When the template has no `{text}`, the text is piped to stdin
 * instead, which is what piper expects and also sidesteps argv length limits.
 */

export interface TtsRunResult {
  outPath: string;
  bytes: number;
  delivery: "stdin" | "argv";
}

/**
 * Split a command template into argv tokens: whitespace-separated, with single
 * or double quotes grouping (the quote characters themselves are dropped).
 * Deliberately no escapes, globs, or substitution — this is not a shell.
 */
export function splitCommandTemplate(template: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const ch of template) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote !== null) throw new Error(`Unbalanced ${quote} quote in --tts-cmd template: ${template}`);
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Substitute `{out}` / `{text}` into the tokenized template. Each placeholder
 * is replaced inside its token, never re-split, so text containing spaces or
 * quotes stays one argument.
 */
export function buildTtsArgv(
  template: string,
  text: string,
  outPath: string,
): { argv: string[]; delivery: "stdin" | "argv" } {
  const tokens = splitCommandTemplate(template);
  if (tokens.length === 0) throw new Error("--tts-cmd template is empty.");
  if (!tokens.some((token) => token.includes("{out}"))) {
    throw new Error(
      "--tts-cmd template has no {out} placeholder, so there is no way to know where the tool writes its audio. " +
        'Add {out} where the tool expects its output path, e.g. --tts-cmd "piper --output_file {out}".',
    );
  }
  const delivery = tokens.some((token) => token.includes("{text}")) ? "argv" : "stdin";
  const argv = tokens.map((token) => token.replaceAll("{out}", outPath).replaceAll("{text}", text));
  return { argv, delivery };
}

/**
 * First free `<stem><ext>`, `<stem>-2<ext>`, ... path in `dir` (created if
 * needed). Numbering instead of overwriting: an earlier voiceover may still be
 * referenced by a segment in the draft.
 */
export function collisionSafeOutPath(dir: string, stem = "voiceover", ext = ".wav"): string {
  mkdirSync(dir, { recursive: true });
  let candidate = resolve(dir, `${stem}${ext}`);
  for (let n = 2; existsSync(candidate); n++) candidate = resolve(dir, `${stem}-${n}${ext}`);
  return candidate;
}

const STDERR_TAIL_CHARS = 2000;

/** Run the TTS template and verify it produced a non-empty file at `outPath`. */
export function synthesizeSpeech(text: string, template: string, outPath: string): TtsRunResult {
  const { argv, delivery } = buildTtsArgv(template, text, outPath);
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    input: delivery === "stdin" ? text : undefined,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderrTail = (r.stderr ?? "").slice(-STDERR_TAIL_CHARS).trim();
  const fail = (reason: string): never => {
    // Drop a partial/empty output so the next run's collision-safe name does
    // not step around a dead file.
    rmSync(outPath, { force: true });
    throw new Error(reason + (stderrTail ? `\nstderr: ${stderrTail}` : ""));
  };
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    fail(`TTS command not found: '${cmd}'. Install it or point --tts-cmd at an existing binary.`);
  }
  if (r.error || r.status !== 0) {
    fail(`TTS command failed (${r.error?.message ?? `exited ${r.status}`}): ${cmd} ${args.join(" ")}`);
  }
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    fail(
      `TTS command succeeded but wrote no audio at ${outPath}. ` +
        "Check the template's {out} placeholder sits where the tool expects its output path.",
    );
  }
  return { outPath, bytes: statSync(outPath).size, delivery };
}
