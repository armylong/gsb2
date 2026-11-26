"""Command line interface for thumb-pack."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .packer import PackConfig, generate_pack, resolve_thumb_dimensions
from .probe import choose_frame, probe_video, resolve_binary, sibling_ffprobe
from .samplegen import generate_sample
from .server import serve_pack
from .targets import parse_target_times
from .verifier import verify_pack


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="thumb-pack",
        description="Generate finite multi-page thumbnail sprites and a verification web page.",
    )
    sub = parser.add_subparsers(dest="command")

    g = sub.add_parser("generate", help="generate a thumbnail pack")
    g.add_argument("video", help="single local video file")
    g.add_argument("-o", "--out", default="thumb_pack_out", help="output directory")
    g.add_argument("--dry-run", action="store_true", help="print target-time to source-frame mapping without writing a pack")
    sampling = g.add_argument_group("sampling")
    sampling.add_argument("-i", "--interval", type=float, help="uniform interval in seconds")
    sampling.add_argument("-t", "--times", help="comma/space/JSON list, e.g. 0,1.5,00:00:03.000")
    sampling.add_argument("-T", "--times-file", help="text/JSON file containing target times")

    layout = g.add_argument_group("layout")
    layout.add_argument("--columns", type=int, default=5)
    layout.add_argument("--rows-per-page", type=int, default=2)
    layout.add_argument("--thumb-width", type=int)
    layout.add_argument("--thumb-height", type=int)
    layout.add_argument("--long-edge", type=int, default=192)
    layout.add_argument("--padding", type=int, default=6, help="extra cell padding around frame rect")
    layout.add_argument("--border", type=int, default=1)
    layout.add_argument("--gap", type=int, default=10)
    layout.add_argument("--margin", type=int, default=18)
    layout.add_argument("--label-height", type=int, default=12)
    layout.add_argument("--no-labels", action="store_true")
    layout.add_argument("--fit", choices=["contain", "cover", "stretch"], default="contain")
    layout.add_argument("--black-bars", choices=["keep", "crop"], default="keep")
    layout.add_argument("--crop-limit", type=int, default=24)
    layout.add_argument("--letterbox-color", default="#000000")
    layout.add_argument("--page-color", default="#181c26")
    layout.add_argument("--cell-color", default="#2b3242")
    layout.add_argument("--border-color", default="#5b6478")
    layout.add_argument("--format", choices=["png", "jpg", "jpeg"], default="png")
    layout.add_argument("--jpeg-quality", type=int, default=3)
    layout.add_argument("--force-bad-slot", type=int, action="append", default=[], help=argparse.SUPPRESS)

    bins = g.add_argument_group("external binaries")
    bins.add_argument("--ffmpeg", default="ffmpeg")
    bins.add_argument("--ffprobe")

    s = sub.add_parser("sample", help="generate a deterministic frame-numbered sample video")
    s.add_argument("output")
    s.add_argument("--frames", type=int, default=24)
    s.add_argument("--fps", type=float, default=10.0)
    s.add_argument("--width", type=int)
    s.add_argument("--height", type=int)
    s.add_argument("--vertical", action="store_true")
    s.add_argument("--vfr", action="store_true", help="use irregular frame durations")
    s.add_argument("--start-offset", type=float, default=0.0, help="raw PTS offset in seconds")
    s.add_argument("--ffmpeg", default="ffmpeg")

    v = sub.add_parser("verify", help="verify manifest, pages, rectangles, pointers and pixels")
    v.add_argument("pack_dir")
    v.add_argument("--video", help="source video; defaults to manifest source path if present")
    v.add_argument("--no-pixels", action="store_true")
    v.add_argument("--allow-error-tiles", action="store_true", help="do not fail merely because simulated bad tiles are present")
    v.add_argument("--json", action="store_true", help="print full JSON report")
    v.add_argument("--ffmpeg", default="ffmpeg")
    v.add_argument("--ffprobe")

    w = sub.add_parser("serve", help="serve a pack and optionally its source video on loopback")
    w.add_argument("pack_dir")
    w.add_argument("--video")
    w.add_argument("--host", default="127.0.0.1")
    w.add_argument("--port", type=int, default=8765)
    w.add_argument("--no-open", action="store_true")

    sub.add_parser("selftest", help="generate fixtures and run local end-to-end verification")
    return parser


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    known = {"generate", "sample", "verify", "serve", "selftest", "-h", "--help"}
    if args_list and args_list[0] not in known:
        args_list = ["generate", *args_list]
    parser = build_parser()
    args = parser.parse_args(args_list)
    if not args.command:
        parser.print_help()
        return 0

    try:
        if args.command == "generate":
            return _cmd_generate(args)
        if args.command == "sample":
            return _cmd_sample(args)
        if args.command == "verify":
            return _cmd_verify(args)
        if args.command == "serve":
            return _cmd_serve(args)
        if args.command == "selftest":
            from .selftest import run_selftest

            return 0 if run_selftest() else 1
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        print(f"thumb-pack: error: {exc}", file=sys.stderr)
        return 2
    parser.error(f"unknown command {args.command}")
    return 2


def _cmd_generate(args: argparse.Namespace) -> int:
    config = PackConfig(
        output_dir=args.out,
        interval=args.interval,
        times=args.times,
        times_file=args.times_file,
        columns=args.columns,
        rows_per_page=args.rows_per_page,
        thumb_width=args.thumb_width,
        thumb_height=args.thumb_height,
        long_edge=args.long_edge,
        padding=args.padding,
        border=args.border,
        gap=args.gap,
        margin=args.margin,
        label_height=args.label_height,
        show_labels=not args.no_labels,
        fit=args.fit,
        black_bars=args.black_bars,
        crop_limit=args.crop_limit,
        letterbox_color=args.letterbox_color,
        page_color=args.page_color,
        cell_color=args.cell_color,
        border_color=args.border_color,
        image_format=args.format,
        jpeg_quality=args.jpeg_quality,
        ffmpeg_bin=args.ffmpeg,
        ffprobe_bin=args.ffprobe,
        force_bad_slots=set(args.force_bad_slot or []),
    )
    if args.dry_run:
        return _cmd_dry_run(args.video, config)
    manifest = generate_pack(args.video, config)
    out = Path(args.out).resolve()
    sav = manifest["savings"]
    print(f"✓ generated {sav['slots']} slots / {sav['uniqueSourceFrames']} unique frames")
    print(f"✓ {sav['pageCount']} page image(s), replacing {sav['unpackedImageFiles']} loose files → save {sav['savedFileCount']} files")
    if manifest["validation"]["errorTiles"]:
        print(f"! {manifest['validation']['errorTiles']} error tile(s) kept in fixed grid")
    print(f"  manifest: {out / 'manifest.json'}")
    print(f"  viewer:   {out / 'viewer.html'}")
    print(f"  inspect:  python -m thumb_pack verify {out} --video {Path(args.video).resolve()}")
    print(f"  serve:    python -m thumb_pack serve {out} --video {Path(args.video).resolve()}")
    return 0


def _cmd_dry_run(video: str, config: PackConfig) -> int:
    config.validate()
    ffmpeg_bin = resolve_binary("ffmpeg", None if config.ffmpeg_bin == "ffmpeg" else config.ffmpeg_bin)
    ffprobe_bin = config.ffprobe_bin or sibling_ffprobe(ffmpeg_bin)
    info = probe_video(video, ffprobe_bin)
    width, height = resolve_thumb_dimensions(
        info, config.thumb_width, config.thumb_height, config.long_edge
    )
    targets = parse_target_times(
        times=config.times,
        times_file=config.times_file,
        interval=config.interval,
        duration=info.duration,
    )
    print(
        f"source={info.path}\n"
        f"coded={info.width}x{info.height} display={info.display_width}x{info.display_height} "
        f"rotation={info.rotation} vfr={info.is_vfr} frames={len(info.frames)}\n"
        f"originRawPts={info.origin_raw_pts:.6f} duration={info.duration:.6f} "
        f"thumb={width}x{height}"
    )
    print("slot  target(s) -> decoded frame | normalized PTS | raw PTS | frame interval")
    seen: dict[int, list[int]] = {}
    selected = []
    for slot, target in enumerate(targets):
        frame = choose_frame(info.frames, target)
        selected.append(frame)
        seen.setdefault(frame.index, []).append(slot)
        collision = " COLLISION slots=" + ",".join(map(str, seen[frame.index])) if len(seen[frame.index]) > 1 else ""
        print(
            f"{slot:04d}  t={target:9.6f} -> F{frame.index:04d} "
            f"| {frame.time:9.6f} | {frame.raw_pts:9.6f} "
            f"| [{frame.time:.6f}, +{frame.duration:.6f}){collision}"
        )
    repeated = [slots for slots in seen.values() if len(slots) > 1]
    print(f"targets={len(targets)} uniqueFrames={len(seen)} collisionGroups={len(repeated)}")
    return 0


def _cmd_sample(args: argparse.Namespace) -> int:
    width = args.width or (180 if args.vertical else 320)
    height = args.height or (320 if args.vertical else 180)
    meta = generate_sample(
        args.output,
        frame_count=args.frames,
        fps=args.fps,
        width=width,
        height=height,
        vfr=args.vfr,
        start_offset=args.start_offset,
        ffmpeg_bin=args.ffmpeg,
    )
    print(f"✓ sample: {meta['file']}")
    print(f"  {meta['width']}x{meta['height']}, {meta['frameCount']} frames, vfr={meta['vfr']}, offset={meta['outputTsOffset']}")
    print(f"  sidecar: {meta['file']}.frames.json")
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    ffmpeg_bin = resolve_binary("ffmpeg", None if args.ffmpeg == "ffmpeg" else args.ffmpeg)
    ffprobe_bin = args.ffprobe or sibling_ffprobe(ffmpeg_bin)
    report = verify_pack(
        args.pack_dir,
        video=args.video,
        check_pixels=not args.no_pixels,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
    )
    hard_errors = [e for e in report["errors"] if args.allow_error_tiles and e.get("code") != "TILE_MARKED_ERROR"] if args.allow_error_tiles else report["errors"]
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"pack: {report['packDir']}")
        print(f"pages checked: {len(report['pages'])}; pixel checks: {len(report['pixelChecks'])}")
        for warning in report["warnings"]:
            print(f"warning [{warning['code']}]: {warning['message']}")
        for error in report["errors"]:
            print(f"error [{error['code']}]: {error['message']}")
        if hard_errors:
            print(f"FAIL: {len(hard_errors)} issue(s)")
        else:
            print("PASS")
    return 1 if hard_errors else 0


def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        server, url = serve_pack(args.pack_dir, args.video, host=args.host, port=args.port, open_browser=not args.no_open)
    except OSError as exc:
        print(f"error: could not bind http://{args.host}:{args.port} ({exc}); choose another --port", file=sys.stderr)
        return 2
    print(f"Serving {Path(args.pack_dir).resolve()} at {url}")
    if args.video:
        print(f"Source video route: {url.rsplit('/', 1)[0]}/__thumb_pack/video")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
