"""Headless verification: generate a sample, run the pipeline, assert the story.

Run with::

    python -m src.verify            # sample generated in a temp dir
    python -m src.verify --keep     # keep the temp dir and print its path

This is the one runnable command promised in the README.  It checks, in order:

1. the generator produced the expected clip geometry and a clean reference;
2. the hard cut is found at the documented frame (and only there);
3. windows never cross a cut, are clipped at shot edges, and are flagged
   "degraded" exactly when fewer than MIN_SAMPLES frames are available;
4. direct mean removes static grain but smears the moving subject; the
   motion-attenuated filter removes grain without smearing it;
5. the exported file keeps the frame count, timing and the audio stream.

Exit code is 0 only if every check passes.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import analysis
import frameio
import metrics as metrics_mod
import sample_common as C
import sample_gen


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes = 0

    def check(self, ok: bool, label: str, detail: str = "") -> None:
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {label}" + (f"  ({detail})" if detail else ""))
        if ok:
            self.passes += 1
        else:
            self.failures.append(label)

    def close(self) -> str:
        total = self.passes + len(self.failures)
        if self.failures:
            return f"{self.passes}/{total} checks passed; FAILED: " + "; ".join(self.failures)
        return f"{self.passes}/{total} checks passed"


def _probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def verify(root: Path, keep: bool, do_export: bool) -> int:
    c = Checks()
    print(f"sample dir: {root}\n")

    # 1. sample geometry -----------------------------------------------------
    manifest = sample_gen.generate(root)
    c.check(manifest["frame_count"] == C.FRAME_COUNT,
            "generator frame count", f"{manifest['frame_count']}")
    c.check(manifest["cut_frame"] == C.CUT_FRAME,
            "generator cut frame", str(manifest["cut_frame"]))
    for name in (C.ORIGINAL_NAME, C.CLEAN_NAME, C.MASK_NAME, C.AUDIO_NAME):
        c.check((root / name).exists(), f"artifact {name} exists")

    bundle = frameio.load_bundle(root, scale=0.5)
    seq = bundle["original"]
    clean = bundle["clean"]
    c.check(len(seq) == C.FRAME_COUNT, "decoded frame count", str(len(seq)))
    c.check(len(clean) == len(seq), "clean reference aligns with original")

    frames = [seq.read(i) for i in range(len(seq))]
    noise = [analysis.rmse(frames[i], clean.read(i)) for i in range(len(seq))]
    c.check(float(np.mean(noise)) > 3.0, "source has meaningful grain",
            f"raw-vs-clean RMSE {np.mean(noise):.2f}")

    # 2. cut detection -------------------------------------------------------
    cuts = analysis.detect_cuts(frames)
    shots = analysis.build_shots(cuts, len(seq))
    c.check(cuts == [0, C.CUT_FRAME], "cut detected exactly at the known frame",
            f"detected {cuts}")
    c.check(len(shots) == 2, "clip split into two shots", str(shots))

    # 3. window rules --------------------------------------------------------
    radius = 3
    bad = []
    for shot in shots:
        for f in range(shot.start, shot.end + 1):
            w = analysis.window_for(f, shot, radius)
            if any(x < shot.start or x > shot.end for x in w.frames):
                bad.append((f, "crosses cut"))
            if w.frames != sorted(set(w.frames)):
                bad.append((f, "not sorted/unique"))
            if f not in w.frames:
                bad.append((f, "missing current frame"))
            expected_degraded = len(w.frames) < analysis.MIN_SAMPLES
            if w.degraded != expected_degraded:
                bad.append((f, "degraded flag wrong"))
    c.check(not bad, "windows stay inside their shot, centered/clipped, flagged correctly",
            f"{len(bad)} violations" if bad else "all frames")

    w_first = analysis.window_for(0, shots[0], radius)
    w_cut = analysis.window_for(C.CUT_FRAME, shots[1], radius)
    w_last = analysis.window_for(len(seq) - 1, shots[-1], radius)
    c.check(w_first.frames == [0, 1, 2, 3] and w_first.clipped,
            "first frame: clipped, never padded", str(w_first.frames))
    c.check(w_cut.frames == [82, 83, 84, 85],
            "first frame after cut uses only shot B", str(w_cut.frames))
    c.check(w_last.frames == [196, 197, 198, 199] and w_last.clipped,
            "last frame: clipped, never padded", str(w_last.frames))
    w_r0 = analysis.window_for(20, shots[0], 0)
    c.check(w_r0.frames == [20] and w_r0.degraded,
            "radius 0 is a documented pass-through")

    # 4. filters -------------------------------------------------------------
    params = analysis.Params(radius=radius, motion_threshold=26.0)
    cache = metrics_mod.MetricsCache(bundle, cuts)
    cm = cache.get(params)
    print("\n  metric summary (RMSE vs clean, mean over frames):")
    print(f"  {'region':8} {'raw':>7} {'mean':>7} {'atten':>7}")
    for region in ("static", "moving"):
        print(f"  {region:8} {cm.mean_of('raw_'+region):7.2f} "
              f"{cm.mean_of('mean_'+region):7.2f} {cm.mean_of('atten_'+region):7.2f}")
    print()

    static_gain = 1.0 - cm.mean_of("mean_static") / cm.mean_of("raw_static")
    c.check(static_gain > 0.4, "direct mean removes static grain",
            f"{static_gain * 100:.0f}% lower static RMSE")
    c.check(cm.mean_of("atten_static") <= cm.mean_of("mean_static") * 1.05,
            "attenuated filter also removes static grain",
            f"atten {cm.mean_of('atten_static'):.2f} vs mean {cm.mean_of('mean_static'):.2f}")
    c.check(cm.mean_of("mean_moving") > cm.mean_of("raw_moving") * 2.5,
            "direct mean smears the moving subject (ghost trail)",
            f"moving RMSE {cm.mean_of('mean_moving'):.2f} vs raw {cm.mean_of('raw_moving'):.2f}")
    c.check(cm.mean_of("atten_moving") < cm.mean_of("mean_moving") * 0.45,
            "attenuation protects the moving subject",
            f"moving RMSE {cm.mean_of('atten_moving'):.2f} vs mean {cm.mean_of('mean_moving'):.2f}")

    # Monte-Carlo sanity: every frame must be computable, no crashes/holes
    hole = [i for i in range(len(seq)) if cm.at(i) is None]
    c.check(not hole, "metrics exist for every frame", f"{len(hole)} holes" if hole else "")

    # 5. export --------------------------------------------------------------
    if do_export:
        out = root / "verify_export.mp4"
        frameio.export_video(bundle, shots, params, "atten", out)
        probe = _probe(out)
        v = next(s for s in probe["streams"] if s["codec_type"] == "video")
        a = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
        nb = int(v.get("nb_frames", 0))
        dur = float(v.get("duration", 0.0))
        c.check(nb == C.FRAME_COUNT, "export has every frame", f"{nb} frames")
        c.check(abs(dur - C.DURATION_S) < 0.1, "export timing preserved",
                f"{dur:.3f}s vs {C.DURATION_S:.3f}s")
        c.check(v.get("r_frame_rate") == f"{C.FPS}/1", "export frame rate preserved",
                str(v.get("r_frame_rate")))
        c.check(a is not None, "export keeps an audio stream",
                a.get("codec_name") if a else "missing")
        if a is not None:
            c.check(abs(float(a.get("duration", 0.0)) - C.DURATION_S) < 0.25,
                    "audio duration matches video", f"{float(a['duration']):.3f}s")

        # Export must be reproducible from the same inputs.
        out2 = root / "verify_export_again.mp4"
        frameio.export_video(bundle, shots, params, "atten", out2)
        c.check(out.read_bytes() == out2.read_bytes(),
                "export is deterministic across runs")

    summary = c.close()
    print("\n" + summary)
    if not keep:
        import shutil
        shutil.rmtree(root, ignore_errors=True)
    else:
        print(f"artifacts kept in {root}")
    return 0 if not c.failures else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", type=Path, default=None,
                    help="sample directory (default: a fresh temp dir)")
    ap.add_argument("--keep", action="store_true", help="keep the temp dir")
    ap.add_argument("--no-export", action="store_true",
                    help="skip the ffmpeg round-trip (faster)")
    args = ap.parse_args()
    root = args.dir or Path(tempfile.mkdtemp(prefix="denoise-verify-"))
    return verify(root, keep=args.keep or args.dir is not None,
                  do_export=not args.no_export)


if __name__ == "__main__":
    raise SystemExit(main())
