import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROBED_FILTERS } from "../../dist/render.js";

const ENCODER_LINES = {
  libx264: " V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  aac: " A....D aac                  AAC (Advanced Audio Coding)",
  mov_text: " S..... mov_text             3GPP Timed Text subtitle",
};

/**
 * A /bin/sh ffmpeg stand-in. `-filters` lists `filters` (by default every filter render probes, so a filter the
 * render chain gains reaches every fake), `-encoders` lists `encoders`. With `writesOutput` it creates its last
 * argument (the output file) and exits 0; otherwise any other call exits 1.
 */
export function writeFakeFfmpeg(
  dir,
  { filters = PROBED_FILTERS, encoders = ["libx264", "aac"], writesOutput = false } = {},
) {
  const path = join(dir, "fake-ffmpeg");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *-filters*)",
      "    cat <<'EOF'",
      ...filters.map((name) => ` ... ${name.padEnd(18)} A->A       fake.`),
      "EOF",
      "    exit 0 ;;",
      "  *-encoders*)",
      "    cat <<'EOF'",
      "Encoders:",
      " V..... = Video",
      " ------",
      ...encoders.map((name) => ENCODER_LINES[name]),
      "EOF",
      "    exit 0 ;;",
      "esac",
      ...(writesOutput ? ['for last; do :; done; : > "$last"', "exit 0"] : ["exit 1"]),
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}
