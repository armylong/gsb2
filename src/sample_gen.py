"""Deterministic synthetic short: static texture, temporal grain, flicker, cut.

The sample has two shots separated by a hard cut at frame 82 (25 fps):

* Shot A   - a warm stone-wall-like texture with a bright disc sweeping across it.
* Shot B   - a cooler diagonal-stripe texture with the disc sweeping back.

Every frame is built from a shared, seeded ``clean`` plate per shot plus grain
that changes every frame (the noise a temporal filter should remove) and a slow
global flicker (also removable).  The raw ``original.mp4`` is encoded from these
frames, so re-running the generator reproduces the same numbers.

``clean_ground_truth.mp4`` and ``moving_mask.mp4`` are written as side-car
references for the preview window and for the verification command; they are
not used by the denoiser itself.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sample_common as C  # noqa: E402


def _rng(tag: str) -> np.random.Generator:
    tag_hash = sum(ord(ch) * (i + 1) for i, ch in enumerate(tag))
    return np.random.default_rng(C.SEED + tag_hash * 7919)


def _clean_plate(shot: int) -> np.ndarray:
    """Fixed, low-frequency texture plate (BGR uint8) for one shot."""
    rng = _rng(f"plate-{shot}")
    yy, xx = np.mgrid[0:C.HEIGHT, 0:C.WIDTH].astype(np.float32)
    u, v = xx / C.WIDTH, yy / C.HEIGHT

    if shot == 0:
        # Warm, bright stone wall.
        base = 92 + 34 * np.sin(2 * math.pi * (3.0 * u + 0.8 * v))
        base += 22 * np.sin(2 * math.pi * (9.0 * u - 2.0 * v))
        base += 14 * np.cos(2 * math.pi * (2.0 * u + 5.0 * v))
        low = rng.normal(0.0, 1.0, (12, 20)).astype(np.float32)
        low = cv2.resize(low, (C.WIDTH, C.HEIGHT), interpolation=cv2.INTER_CUBIC)
        base += 18 * low
        tint = np.array([0.58, 0.74, 1.00], np.float32)   # warm: B<G<R
    else:
        # Cool, dark blue-striped wall: a clear luminance break from shot A.
        diag = 2 * math.pi * (11.0 * u + 7.0 * v)
        base = 62 + 20 * np.sin(diag)
        base += 13 * np.cos(2 * math.pi * (3.5 * u - 8.0 * v))
        low = rng.normal(0.0, 1.0, (16, 26)).astype(np.float32)
        low = cv2.resize(low, (C.WIDTH, C.HEIGHT), interpolation=cv2.INTER_CUBIC)
        base += 14 * low
        tint = np.array([1.00, 0.78, 0.52], np.float32)   # cool: B>G>R

    plate = base[:, :, None] * tint[None, None, :]
    return np.clip(plate, 8, 247).astype(np.uint8)


def _draw_subject(img: np.ndarray, frame: int) -> cv2.typing.MatLike:
    """Paint the moving disc with a small highlight so it has internal detail."""
    cx, cy = C.subject_center(frame)
    out = img.copy()
    cv2.circle(out, (int(round(cx)), int(round(cy))), C.SUBJECT_RADIUS,
               C.SUBJECT_COLOR_BGR, thickness=-1, lineType=cv2.LINE_AA)
    hx, hy = int(round(cx - C.SUBJECT_RADIUS * 0.32)), int(round(cy - C.SUBJECT_RADIUS * 0.32))
    cv2.circle(out, (hx, hy), max(3, C.SUBJECT_RADIUS // 4), (210, 232, 255),
               thickness=-1, lineType=cv2.LINE_AA)
    return out


def _moving_mask(frame: int) -> np.ndarray:
    """0/255 mask of the moving subject, dilated for a safe comparison region."""
    mask = np.zeros((C.HEIGHT, C.WIDTH), np.uint8)
    cx, cy = C.subject_center(frame)
    cv2.circle(mask, (int(round(cx)), int(round(cy))),
               C.SUBJECT_RADIUS + C.SUBJECT_DILATE, 255, thickness=-1)
    return mask


def clean_frame(frame: int) -> np.ndarray:
    """Ground-truth frame with no grain and no flicker."""
    shot = 0 if frame < C.CUT_FRAME else 1
    return _draw_subject(_clean_plate(shot), frame)


def noisy_frame(frame: int) -> np.ndarray:
    """Clean frame + per-frame grain + a slow global flicker + woven-in texture flicker."""
    clean = clean_frame(frame).astype(np.float32)
    rng = np.random.default_rng(C.NOISE_SEED + frame * 104729)
    grain = rng.normal(0.0, 9.0, (C.HEIGHT, C.WIDTH, 3)).astype(np.float32)
    # Flicker: a global brightness wobble that a strong temporal average removes.
    flicker = 6.5 * math.sin(2 * math.pi * frame / 6.0 + 0.4)
    # Fine, per-frame texture shimmer on the static wall: the kind of "shadow
    # flicker" that survives a single-frame denoiser but averages away over time.
    shimmer_rng = np.random.default_rng(C.FLICKER_SEED + frame * 7919)
    shimmer = shimmer_rng.normal(0.0, 3.2, (C.HEIGHT, C.WIDTH, 1)).astype(np.float32)
    out = clean + grain + flicker + shimmer
    return np.clip(out, 0, 255).astype(np.uint8)


def _encode(frames_dir: Path, out_path: Path, audio: Path | None) -> None:
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", str(C.FPS), "-start_number", "0",
        "-i", str(frames_dir / "f_%04d.png"),
    ]
    if audio:
        cmd += ["-i", str(audio), "-map", "0:v:0", "-map", "1:a:0",
                "-c:a", "aac", "-b:a", "128k", "-shortest"]
    else:
        cmd += ["-map", "0:v:0"]
    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _make_audio(out_path: Path) -> None:
    """A quiet two-note tone so audio preservation is observable."""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i",
        f"sine=frequency=440:duration={C.SHOT_A_LEN / C.FPS}:sample_rate=48000",
        "-f", "lavfi", "-i",
        f"sine=frequency=660:duration={C.SHOT_B_LEN / C.FPS}:sample_rate=48000",
        "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
        "-map", "[a]", "-c:a", "pcm_s16le", "-t", str(C.DURATION_S),
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _write_frames(out_dir: Path, kind: str) -> Path:
    frames_dir = out_dir / f"_frames_{kind}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for i in range(C.FRAME_COUNT):
        img = noisy_frame(i) if kind == "noisy" else clean_frame(i)
        cv2.imwrite(str(frames_dir / f"f_{i:04d}.png"), img)
    return frames_dir


def _write_mask(out_dir: Path) -> Path:
    frames_dir = out_dir / "_frames_mask"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for i in range(C.FRAME_COUNT):
        cv2.imwrite(str(frames_dir / f"f_{i:04d}.png"), _moving_mask(i))
    return frames_dir


def generate(out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    audio = out_dir / C.AUDIO_NAME
    _make_audio(audio)

    noisy_dir = _write_frames(out_dir, "noisy")
    clean_dir = _write_frames(out_dir, "clean")
    mask_dir = _write_mask(out_dir)

    _encode(noisy_dir, out_dir / C.ORIGINAL_NAME, audio)
    _encode(clean_dir, out_dir / C.CLEAN_NAME, audio)
    _encode(mask_dir, out_dir / C.MASK_NAME, None)

    for d in (noisy_dir, clean_dir, mask_dir):
        for p in d.glob("*.png"):
            p.unlink()
        d.rmdir()

    manifest = {
        "version": 1,
        "fps": C.FPS,
        "width": C.WIDTH,
        "height": C.HEIGHT,
        "frame_count": C.FRAME_COUNT,
        "cut_frame": C.CUT_FRAME,
        "cut_reference": C.CUT_FRAME / C.FPS,
        "shots": [[s, e] for s, e in C.shot_bounds()],
        "seed": C.SEED,
        "audio_hz_shot_a": 440,
        "audio_hz_shot_b": 660,
        "original": C.ORIGINAL_NAME,
        "clean": C.CLEAN_NAME,
        "mask": C.MASK_NAME,
        "audio": C.AUDIO_NAME,
    }
    (out_dir / C.MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate the synthetic denoise sample.")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "samples")
    args = ap.parse_args()
    m = generate(args.out)
    print(f"wrote {args.out} ({m['frame_count']} frames @ {m['fps']} fps, cut at frame {m['cut_frame']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
