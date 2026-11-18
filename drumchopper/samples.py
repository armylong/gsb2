"""Generate a small synthetic drum loop with known onset positions.

The loop is fully synthesised: a kick/snare/hat pattern plus one long
"crash" tail.  Every attack is placed on an exact sample index and the
resulting JSON lists those indices, so tests never need to trust the
onset detector.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

SR = 44100


@dataclass
class Hit:
    name: str
    start: int
    duration: int


def _kick(sr: int, duration: float = 0.38) -> np.ndarray:
    n = int(duration * sr)
    t = np.arange(n) / sr
    freq = 118.0 * np.exp(-t * 18.0) + 43.0
    phase = 2 * np.pi * np.cumsum(freq) / sr
    env = np.exp(-t * 9.0)
    body = np.sin(phase) * env
    click = np.exp(-t * 260.0) * np.sin(2 * np.pi * 1900.0 * t) * 0.35
    return (body + click).astype(np.float64)


def _snare(sr: int, duration: float = 0.24, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n)
    noise = np.diff(np.concatenate([[0.0], noise]))  # crude high-pass
    tone = np.sin(2 * np.pi * 185.0 * t) * np.exp(-t * 13.0) * 0.6
    burst = np.exp(-t * 90.0) * rng.standard_normal(n) * 0.4
    return (noise * np.exp(-t * 22.0) * 0.55 + tone + burst).astype(np.float64)


def _hat(sr: int, duration: float = 0.055, seed: int = 2) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    t = np.arange(n) / sr
    noise = np.diff(np.concatenate([[0.0], rng.standard_normal(n)]))
    return (noise * np.exp(-t * 90.0) * 0.22).astype(np.float64)


def _crash(sr: int, duration: float = 1.25, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n)
    tone = (
        0.5 * np.sin(2 * np.pi * 340.0 * t)
        + 0.3 * np.sin(2 * np.pi * 527.0 * t + 1.1)
        + 0.2 * np.sin(2 * np.pi * 811.0 * t + 2.2)
    )
    return ((noise * 0.35 + tone * 0.4) * np.exp(-t * 2.1)).astype(np.float64)


def _kick_seeded(sr: int, seed: int) -> np.ndarray:
    del seed
    return _kick(sr)


def _snare_seeded(sr: int, seed: int) -> np.ndarray:
    return _snare(sr, seed=seed)


def _hat_seeded(sr: int, seed: int) -> np.ndarray:
    return _hat(sr, seed=seed)


def _crash_seeded(sr: int, seed: int) -> np.ndarray:
    return _crash(sr, seed=seed)


_PATTERNS = {
    "kick": _kick_seeded,
    "snare": _snare_seeded,
    "hat": _hat_seeded,
    "crash": _crash_seeded,
}


def generate_demo(seconds: float = 3.2, samplerate: int = SR,
                  stereo: bool = True) -> tuple[np.ndarray, list[Hit]]:
    """Return ``(samples, hits)`` for a one-bar-ish loop.

    Hits are placed on exact sample indices.  In stereo mode instruments
    are panned independently (kick slightly left, snare right, hats more
    right) so the two channels genuinely differ.
    """
    total = int(round(seconds * samplerate))
    mix = np.zeros((total, 2), dtype=np.float64)
    hits: list[Hit] = []

    kind_rank = {name: i for i, name in enumerate(_PATTERNS)}

    def place(kind: str, at_s: float, gain: float, pan: float) -> None:
        at = int(round(at_s * samplerate))
        if at >= total:
            return
        # deterministic seed: same sample position always yields same audio
        clip = _PATTERNS[kind](samplerate, seed=kind_rank[kind] * 1_000_003 + at)
        end = min(total, at + clip.size)
        take = end - at
        if take <= 0:
            return
        # equal-power pan, pan in [-1, 1]
        angle = (pan + 1.0) * np.pi / 4.0
        gl, gr = np.cos(angle), np.sin(angle)
        mix[at:end, 0] += clip[:take] * gain * gl
        mix[at:end, 1] += clip[:take] * gain * gr
        hits.append(Hit(kind, at, take))

    for beat in range(int(np.ceil(seconds * 2))):
        t = beat * 0.5
        if t >= seconds:
            break
        place("kick", t, 0.9, -0.30)
        if beat % 2 == 1:
            place("snare", t, 0.85, 0.35)
        place("hat", t + 0.25, 0.7, 0.55)

    # Long tail: starts at 1.0 s and rings for 1.25 s, crossing several steps.
    place("crash", 1.0, 0.6, 0.0)

    hits.sort(key=lambda h: h.start)
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.95:
        mix *= 0.95 / peak

    if not stereo:
        mono = mix.mean(axis=1)
        return mono.astype(np.float32), hits
    return mix.astype(np.float32), hits


def write_demo(out_wav: str | Path, out_json: str | Path | None = None,
               seconds: float = 3.2, samplerate: int = SR,
               stereo: bool = True) -> dict:
    from drumchopper.audio import write_wav

    samples, hits = generate_demo(seconds=seconds, samplerate=samplerate, stereo=stereo)
    out_wav = Path(out_wav)
    write_wav(out_wav, samples, samplerate)
    meta = {
        "file": out_wav.name,
        "samplerate": samplerate,
        "channels": 2 if stereo else 1,
        "frames": int(samples.shape[0]),
        "duration": float(samples.shape[0]) / samplerate,
        "onsets": [h.start for h in hits],
        "hits": [asdict(h) for h in hits],
    }
    if out_json is not None:
        Path(out_json).write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return meta


if __name__ == "__main__":  # pragma: no cover
    import argparse

    parser = argparse.ArgumentParser(description="生成合成鼓样例")
    parser.add_argument("out_wav", nargs="?", default="samples/demo_drums.wav")
    parser.add_argument("--json", default=None)
    parser.add_argument("--seconds", type=float, default=3.2)
    parser.add_argument("--mono", action="store_true")
    args = parser.parse_args()
    json_path = args.json
    if json_path is None and args.out_wav.endswith(".wav"):
        json_path = args.out_wav[:-4] + "_onsets.json"
    meta = write_demo(args.out_wav, json_path, seconds=args.seconds, stereo=not args.mono)
    print(f"写入 {args.out_wav}  {meta['frames']} 采样 / {meta['duration']:.3f}s")
    print(f"已知起音 {meta['onsets']}")
