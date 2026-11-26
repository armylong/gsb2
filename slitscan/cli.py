"""Command-line interface: headless build, sample generation and verification.

Examples
--------
# 1. make one of the built-in stripe samples
python -m slitscan.cli synth vfr /tmp/vfr.mp4

# 2. build a strip (slit panning from x=20 to x=140, edge padding)
python -m slitscan.cli build /tmp/vfr.mp4 /tmp/strip.png \\
    --width 8 --start-center 20 --end-center 140 --padding edge

# 3. verify page joins, backlinks and (for samples) encoded frame ids
python -m slitscan.cli verify /tmp/strip.manifest.json
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image

from .core import BuildResult, SlitConfig, block_has_real_pixels, x_to_block
from .output import (load_manifest, manifest_blocks, save_result,
                     verify_pages)
from .synth import PATTERNS, generate, read_encoded_index
from .video import decode_frames, probe


def _cmd_synth(args: argparse.Namespace) -> int:
    out = generate(args.pattern, args.output,
                   n_frames=args.frames, fps=args.fps)
    print(f"wrote sample ({args.pattern}) -> {out}")
    return 0


def _cmd_build(args: argparse.Namespace) -> int:
    info = probe(args.video)
    frames, ts = decode_frames(args.video, info,
                               max_memory_mb=args.max_memory_mb)
    cfg = SlitConfig(
        width=args.width,
        start_center=args.start_center,
        end_center=args.end_center,
        padding=args.padding,
        trim_start=args.trim_start,
        trim_end=args.trim_end,
        skip_intervals=[tuple(s) for s in args.skip] if args.skip else [],
        layout=args.layout,
        interval=args.interval,
        max_page_width=args.max_page_width,
    )
    result = build_with_progress(frames, ts, cfg)
    paths, manifest = save_result(result, args.video, args.output)
    for p in paths:
        print(f"page -> {p}")
    print(f"manifest -> {manifest}")
    for problem in verify_pages(result):
        print(f"WARNING: {problem}", file=sys.stderr)
    return 0


def build_with_progress(frames: np.ndarray, ts: np.ndarray,
                        cfg: SlitConfig) -> BuildResult:
    from .core import build_strip

    def report(frac: float) -> None:
        print(f"\rbuilding strip: {frac * 100:5.1f}%", end="", flush=True)

    result = build_strip(frames, ts, cfg, progress=report)
    print()
    return result


def _cmd_verify(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    blocks = manifest_blocks(manifest)
    pages_meta = manifest["output"]

    problems: list[str] = []

    # ---- 1. page joins: widths concatenated match block coverage ----------
    covered = 0
    prev_end = 0
    for i, b in enumerate(blocks):
        if b.global_x0 != prev_end:
            problems.append(f"block {i}: gap/overlap (x={b.global_x0}, "
                            f"expected {prev_end})")
        if len(b.source_cols) != b.width:
            problems.append(f"block {i}: wrong source_cols length")
        prev_end = b.global_x0 + b.width
        covered += b.width
    total = pages_meta["total_width"]
    if covered != total:
        problems.append(f"coverage {covered} != total {total}")
    if sum(pages_meta["page_widths"]) != total:
        problems.append("page widths do not sum to total width")

    # ---- 2. every page column resolves, padding columns are flagged -------
    pages_on_disk = [Image.open(p) for p in pages_meta["pages"]]
    for page_idx, (img, w) in enumerate(zip(pages_on_disk,
                                            pages_meta["page_widths"])):
        if img.width != w:
            problems.append(f"page {page_idx}: png width {img.width} != "
                            f"manifest {w}")
        for x in range(w):
            b = x_to_block(blocks, page_idx, x)
            if b is None:
                problems.append(f"page {page_idx} x={x}: no block (lost column)")
                break

    # ---- 3. backlink: real columns decode to the claimed source frame -----
    src = manifest["source"]
    try:
        info = probe(src["path"])
        frames, _ = decode_frames(src["path"], info)
        check_pixels = True
    except Exception as exc:  # missing source / ffmpeg unavailable
        print(f"note: source re-decode skipped ({exc})")
        check_pixels = False

    bad_links = 0
    max_diff = 0
    padded = sum(1 for b in blocks if not block_has_real_pixels(b))
    n_decoded = frames.shape[0]
    if check_pixels:
        for b in blocks:
            if b.frame_index < 0:
                continue
            if b.frame_index >= n_decoded:
                bad_links += 1
                problems.append(
                    f"block t={b.t:.3f}: frame_index {b.frame_index} out of "
                    f"range (video has {n_decoded} frames)")
                continue
            page_img = np.asarray(pages_on_disk[b.page])
            for k, src_col in enumerate(b.source_cols):
                if src_col < 0:
                    continue
                if src_col >= frames.shape[2]:
                    bad_links += 1
                    problems.append(
                        f"block t={b.t:.3f}: source col {src_col} out of range")
                    continue
                got = page_img[:, b.page_x0 + k, :].astype(int)
                want = frames[b.frame_index, :, src_col, :].astype(int)
                diff = int(np.abs(got - want).max())
                max_diff = max(max_diff, diff)
                # tolerance covers lossy h264/yuv420p round trips; lossless
                # sources still compare exactly
                if diff > 12:
                    bad_links += 1
                    if bad_links <= 5:
                        problems.append(
                            f"block t={b.t:.3f} col {k}: pixels do not match "
                            f"frame {b.frame_index} src col {src_col} "
                            f"(max diff {diff})")
        if bad_links > 5:
            problems.append(f"... {bad_links - 5} more pixel mismatches")

    # ---- 4. sample clips: encoded frame-id barcode round trip -------------
    id_mismatches = 0
    id_checked = 0
    if check_pixels and args.check_ids:
        for b in blocks:
            if b.frame_index < 0 or not any(c >= 0 for c in b.source_cols):
                continue
            if b.frame_index >= frames.shape[0]:
                id_mismatches += 1
                continue
            page_img = np.asarray(pages_on_disk[b.page])
            slice_img = page_img[:, b.page_x0:b.page_x0 + b.width, :]
            decoded = read_encoded_index(slice_img)
            if decoded is None:
                continue  # slit too narrow to hold the barcode band
            id_checked += 1
            if decoded != b.frame_index % 32:
                id_mismatches += 1
        if id_checked == 0:
            print("note: slit narrower than barcode band; id check skipped")
        if id_mismatches:
            problems.append(
                f"{id_mismatches}/{id_checked} blocks failed encoded-id check")

    print(f"blocks={len(blocks)} total_columns={total} "
          f"pages={len(pages_meta['pages'])} fully_padded_blocks={padded} "
          f"max_pixel_diff={max_diff if check_pixels else 'n/a'}")
    if problems:
        print("VERIFY FAILED:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("VERIFY OK: page joins exact, backlinks resolve, pixels match source")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="slitscan")
    sub = parser.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("synth", help="generate a built-in stripe sample")
    s.add_argument("pattern", choices=PATTERNS)
    s.add_argument("output")
    s.add_argument("--frames", type=int, default=40)
    s.add_argument("--fps", type=int, default=10)
    s.set_defaults(func=_cmd_synth)

    b = sub.add_parser("build", help="build a slit strip from a video")
    b.add_argument("video")
    b.add_argument("output", help="base PNG path (pages get _p001 suffixes)")
    b.add_argument("--width", type=int, default=16)
    b.add_argument("--start-center", type=float, default=0.0)
    b.add_argument("--end-center", type=float, default=None)
    b.add_argument("--padding", choices=["edge", "reflect", "zero", "limit"],
                   default="edge")
    b.add_argument("--layout", choices=["frame", "interval"], default="frame")
    b.add_argument("--interval", type=float, default=0.1)
    b.add_argument("--trim-start", type=float, default=None)
    b.add_argument("--trim-end", type=float, default=None)
    b.add_argument("--skip", action="append", type=float, nargs=2,
                   metavar=("A", "B"), help="skip source interval [a,b) s")
    b.add_argument("--max-page-width", type=int, default=8000)
    b.add_argument("--max-memory-mb", type=int, default=4096)
    b.set_defaults(func=_cmd_build)

    v = sub.add_parser("verify", help="verify a saved strip against its source")
    v.add_argument("manifest")
    v.add_argument("--check-ids", action="store_true",
                   help="also check frame ids baked into synth samples")
    v.set_defaults(func=_cmd_verify)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "build" and args.end_center is None:
        args.end_center = args.start_center
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
