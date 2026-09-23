#!/usr/bin/env python3
"""
Prompt + narration -> fal image, video and voiceover -> one editable CapCut / JianYing draft.

    FAL_KEY=... python3 examples/scripts/fal-to-draft.py \\
        --prompt "a lighthouse on a cliff at dusk, waves below" \\
        --script script.txt --name "fal short" [--drafts <dir>]

Steps (each one fal request on the queue API, then one capcut command):
    1. image   fal-ai/flux/schnell                          portrait still from --prompt
    2. video   fal-ai/kling-video/v2.1/standard/image-to-video   the still, animated (5 s)
    3. voice   fal-ai/kokoro/american-english               voiceover from --script
    4. compile one spec: animated clip, then the still held until the voiceover ends,
               the voiceover, and a title card
    5. caption optional, needs whisper: captions timed on the voiceover, worded from --script
    6. lint

Every asset is downloaded into <work>/ (default ./fal-<name>/) and copied into the draft,
so the draft keeps working after fal's file URLs expire. Rerunning with the same --work
reuses files already there and skips their fal request.

Model ids are flags (--image-model, --video-model, --tts-model): any fal model whose
output has images[0].url, video.url or audio.url plugs in. FAL_QUEUE_URL overrides the
queue host (default https://queue.fal.run).

Needs: Python 3.9+ (stdlib only), capcut on PATH (npm i -g capcut-cli), ffprobe for
exact durations (without it: 5 s video, voiceover length from the WAV header).
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave

QUEUE = os.environ.get("FAL_QUEUE_URL", "https://queue.fal.run").rstrip("/")


def fail(msg):
    print(f"fal-to-draft: {msg}", file=sys.stderr)
    sys.exit(1)


def http_json(url, key, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    method = method or ("POST" if data else "GET")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Key {key}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        fail(f"{method} {url} -> HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")


def fal(model, args, key, timeout_s):
    """Submit to the fal queue, poll until COMPLETED, return the result JSON."""
    sub = http_json(f"{QUEUE}/{model}", key, args)
    status_url = sub.get("status_url") or f"{QUEUE}/{model}/requests/{sub['request_id']}/status"
    response_url = sub.get("response_url") or f"{QUEUE}/{model}/requests/{sub['request_id']}"
    deadline = time.time() + timeout_s
    while True:
        st = http_json(status_url, key)
        if st.get("status") == "COMPLETED":
            if st.get("error"):
                fail(f"{model} failed: {st['error']}")
            return http_json(response_url, key)
        if time.time() > deadline:
            fail(f"{model} still {st.get('status')} after {timeout_s}s (request {sub.get('request_id')})")
        time.sleep(2)


def download(url, dest):
    if url.startswith("data:"):
        fail("got a data URI; drop sync_mode from the request")
    with urllib.request.urlopen(url, timeout=300) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    if os.path.getsize(dest) == 0:
        fail(f"empty download: {url}")


def ext_of(url, fallback):
    m = re.search(r"\.([A-Za-z0-9]{2,4})(?:\?|$)", url)
    return m.group(1).lower() if m else fallback


def existing(work, stem):
    for f in sorted(os.listdir(work)):
        if f.startswith(stem + ".") and os.path.getsize(os.path.join(work, f)) > 0:
            return os.path.join(work, f)
    return None


def duration(path, fallback):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return round(float(out), 3)
    except (OSError, subprocess.CalledProcessError, ValueError):
        pass
    if path.endswith(".wav"):
        try:
            with wave.open(path) as w:
                return round(w.getnframes() / w.getframerate(), 3)
        except (wave.Error, EOFError):
            pass
    return fallback


def capcut(*args):
    r = subprocess.run(["capcut", *args], capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--prompt", required=True, help="what the picture shows (image + motion prompt)")
    p.add_argument("--script", required=True, help="narration text file, one sentence per line")
    p.add_argument("--name", default="fal short", help="draft name")
    p.add_argument("--title", help="title card text (default: the draft name)")
    p.add_argument("--drafts", help="draft library directory (default: this OS's CapCut store)")
    p.add_argument("--work", help="where fal assets are kept (default: ./fal-<name>)")
    p.add_argument("--motion", help="motion prompt for the video (default: --prompt)")
    p.add_argument("--voice", default="af_heart", help="kokoro voice id (default af_heart)")
    p.add_argument("--image-model", default="fal-ai/flux/schnell")
    p.add_argument("--video-model", default="fal-ai/kling-video/v2.1/standard/image-to-video")
    p.add_argument("--tts-model", default="fal-ai/kokoro/american-english")
    p.add_argument("--timeout", type=int, default=900, help="seconds to wait per fal request")
    a = p.parse_args()

    key = os.environ.get("FAL_KEY")
    if not key:
        fail("set FAL_KEY (https://fal.ai/dashboard/keys)")
    if not shutil.which("capcut"):
        fail("capcut not on PATH: npm install -g capcut-cli")
    try:
        with open(a.script, encoding="utf-8") as f:
            narration = " ".join(line.strip() for line in f if line.strip())
    except OSError as e:
        fail(f"cannot read --script: {e}")
    if not narration:
        fail(f"script is empty: {a.script}")

    slug = re.sub(r"[^A-Za-z0-9]+", "-", a.name).strip("-").lower() or "short"
    work = os.path.abspath(a.work or f"fal-{slug}")
    os.makedirs(work, exist_ok=True)

    # 1. Still image. Its URL feeds step 2, so keep it next to the file.
    image = existing(work, "image")
    url_file = os.path.join(work, "image.url")
    if image and os.path.exists(url_file):
        image_url = open(url_file).read().strip()
        print(f"image:     {image} (reused)")
    else:
        res = fal(a.image_model, {"prompt": a.prompt, "image_size": "portrait_16_9"}, key, a.timeout)
        image_url = (res.get("images") or [{}])[0].get("url") or fail(f"{a.image_model}: no images[0].url")
        image = os.path.join(work, f"image.{ext_of(image_url, 'jpg')}")
        download(image_url, image)
        with open(url_file, "w") as f:
            f.write(image_url)
        print(f"image:     {image}")

    # 2. Animated clip from the still.
    video = existing(work, "video")
    if video:
        print(f"video:     {video} (reused)")
    else:
        res = fal(a.video_model, {"prompt": a.motion or a.prompt, "image_url": image_url}, key, a.timeout)
        vurl = (res.get("video") or {}).get("url") or fail(f"{a.video_model}: no video.url")
        video = os.path.join(work, f"video.{ext_of(vurl, 'mp4')}")
        download(vurl, video)
        print(f"video:     {video}")

    # 3. Voiceover from the script.
    voice = existing(work, "voice")
    if voice:
        print(f"voiceover: {voice} (reused)")
    else:
        res = fal(a.tts_model, {"prompt": narration, "voice": a.voice}, key, a.timeout)
        aurl = (res.get("audio") or {}).get("url") or fail(f"{a.tts_model}: no audio.url")
        voice = os.path.join(work, f"voice.{ext_of(aurl, 'wav')}")
        download(aurl, voice)
        print(f"voiceover: {voice}")

    # 4. One spec, one compile. The clip plays first; the still holds until the voiceover ends.
    vdur = duration(video, 5.0)
    adur = duration(voice, vdur)
    visual = [{"path": video, "start": 0, "duration": vdur, "ref": "clip"}]
    if adur > vdur:
        visual.append({"path": image, "start": vdur, "duration": round(adur - vdur, 3), "type": "photo"})
    spec = {
        "name": a.name,
        "ratio": "9:16",
        "tracks": [
            {"type": "video", "items": visual},
            {"type": "audio", "name": "voiceover", "items": [{"path": voice, "start": 0, "duration": adur}]},
            {"type": "text", "name": "title", "items": [
                {"text": a.title or a.name, "start": 0, "duration": min(2.5, vdur), "fontSize": 16, "y": -0.6}
            ]},
        ],
    }
    spec_path = os.path.join(work, "spec.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2, ensure_ascii=False)
    code, out, err = capcut("compile", spec_path, *(["--drafts", a.drafts] if a.drafts else []))
    try:
        project = json.loads(out)["draft_path"]
    except (ValueError, KeyError):
        fail(f"compile failed (exit {code}): {(err or out)[:400]}")
    print(f"draft:     {project}")

    # 5. Captions: whisper's timing, the script's wording. Missing whisper is not fatal.
    code, out, err = capcut("caption", project, "--audio", voice, "--script", a.script)
    if code == 0:
        try:
            print(f"captions:  {len(json.loads(out).get('segments', []))} cue(s)")
        except ValueError:
            print("captions:  added")
    else:
        msg = (err or out).strip()
        try:
            msg = json.loads(msg).get("error", msg)
        except ValueError:
            pass
        print(f"captions:  skipped ({(msg.splitlines() or ['exit ' + str(code)])[0][:120]})")

    # 6. Lint, then open in the app.
    code, out, err = capcut("lint", project, "-H")
    print(out.rstrip() or err.rstrip())
    print(f'\nRestart CapCut / JianYing once so it lists the new draft, then open "{a.name}".')
    sys.exit(2 if code == 2 else 0)


if __name__ == "__main__":
    main()
