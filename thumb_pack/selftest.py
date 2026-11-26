"""End-to-end self verification with generated frame-numbered fixtures."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Any

from .packer import PackConfig, generate_pack
from .probe import choose_frame, probe_video, resolve_binary
from .samplegen import generate_sample
from .server import serve_pack
from .targets import parse_target_times
from .verifier import lookup_manifest, verify_pack


CORE_TIMES = [
    0.000, 0.120, 0.240, 0.360, 0.480,
    0.510, 0.570, 0.720, 0.840, 0.960,
    1.080, 1.200, 1.320, 1.440, 1.560,
    1.680, 1.800, 1.920, 2.040, 2.160,
    2.300,
]


def run_selftest(verbose: bool = True) -> bool:
    def log(msg: str) -> None:
        if verbose:
            print(msg)

    root = Path(tempfile.mkdtemp(prefix="thumb-pack-selftest-"))
    try:
        log(f"selftest workspace: {root}")
        _test_time_parsing(log)

        main_video = root / "numbered.mp4"
        generate_sample(
            str(main_video), frame_count=24, fps=10, width=320, height=180
        )
        info = probe_video(str(main_video))
        assert len(info.frames) == 24, len(info.frames)
        assert abs(info.duration - 2.4) < 0.12, info.duration

        pack_dir = root / "pack"
        config = PackConfig(
            output_dir=str(pack_dir),
            times=",".join(str(t) for t in CORE_TIMES),
            columns=5,
            rows_per_page=2,
            thumb_width=160,
            thumb_height=90,
            ffmpeg_bin="ffmpeg",
        )
        manifest = generate_pack(str(main_video), config)
        _assert_core_manifest(manifest)
        log("✓ core scenario: cross-page boundary, same-frame collision, last single cell")

        report = verify_pack(str(pack_dir), video=str(main_video), check_pixels=True)
        if report["errors"]:
            for e in report["errors"]:
                log(f"ERROR {e}")
            raise AssertionError("clean pack verification failed")
        assert len(report["pixelChecks"]) == 21
        log("✓ clean pack: manifest geometry, pointers and page pixels verified")

        _test_bad_tile(root / "bad", main_video, log)
        _test_missing_page(pack_dir, root / "moved-page", main_video, log)
        _test_outside_rect(pack_dir, root / "outside-rect", main_video, log)
        _test_vfr_offset(root, log)
        _test_portrait(root, log)
        _test_rotation_metadata(root, main_video, log)
        _test_server(pack_dir, main_video, log)

        log("\nALL SELFTEST CHECKS PASSED")
        return True
    except Exception as exc:
        import traceback

        log(f"\nSELFTEST FAILED: {type(exc).__name__}: {exc}")
        if verbose:
            traceback.print_exc()
        return False
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _test_time_parsing(log: Any) -> None:
    vals = parse_target_times(times="0, 1.5 00:00:03.250", duration=4)
    assert vals == [0.0, 1.5, 3.25], vals
    json_vals = parse_target_times(times='["00:00:01.000", 2.25]', duration=3)
    assert json_vals == [1.0, 2.25], json_vals
    interval = parse_target_times(interval=1.0, duration=2.0)
    assert interval == [0.0, 1.0, 2.0], interval

    class F:
        def __init__(self, t: float) -> None:
            self.time = t

    frames = [F(0), F(0.1), F(0.2)]
    assert choose_frame(frames, 0.099).time == 0.0
    assert choose_frame(frames, 0.1).time == 0.1  # incoming boundary frame
    assert choose_frame(frames, 99).time == 0.2
    log("✓ time parsing and boundary frame selection")


def _assert_core_manifest(m: dict[str, Any]) -> None:
    assert m["schema"] == "thumb-pack@1"
    assert m["savings"]["requestedTargets"] == 21
    assert m["savings"]["pageCount"] == 3
    assert m["savings"]["savedFileCount"] == 18

    by_slot = {s["slot"]: s for s in m["samples"]}
    expected_frames = [0, 1, 2, 3, 4, 5, 5, 7, 8, 9, 10, 12, 13, 14, 15, 16, 18, 19, 20, 21, 23]
    actual_frames = [by_slot[i]["source"]["frameIndex"] for i in range(len(CORE_TIMES))]
    assert actual_frames == expected_frames, list(zip(CORE_TIMES, actual_frames, expected_frames))
    assert by_slot[5]["source"]["frameIndex"] == by_slot[6]["source"]["frameIndex"] == 5
    assert by_slot[5]["sameFrameSlots"] == [5, 6]
    assert m["frameGroups"][0]["slots"] == [5, 6]

    # Capacity is 5*2 = 10. Slot 9 ends page 1; slot 10 starts page 2.
    assert by_slot[9]["pageIndex"] == 1
    assert by_slot[10]["pageIndex"] == 2
    assert (by_slot[9]["cellRect"]["x"], by_slot[9]["cellRect"]["y"]) != (
        by_slot[10]["cellRect"]["x"],
        by_slot[10]["cellRect"]["y"],
    )
    assert by_slot[10]["cellRect"]["x"] == m["geometry"]["margin"]
    assert by_slot[10]["cellRect"]["y"] == m["geometry"]["margin"]

    # Page 3 contains only slot 20, at the first fixed-grid position.
    assert by_slot[20]["pageIndex"] == 3
    assert by_slot[20]["cellRect"]["x"] == m["geometry"]["margin"]
    assert by_slot[20]["cellRect"]["y"] == m["geometry"]["margin"]
    assert len([s for s in m["samples"] if s["pageIndex"] == 3]) == 1

    duration = m["timeline"]["duration"]
    assert lookup_manifest(m, 0)["slot"] == 0
    assert lookup_manifest(m, duration - 1e-9)["slot"] == 20
    assert lookup_manifest(m, duration)["slot"] == 20

    viewer = Path(m["artifacts"]["viewer"])
    # The caller checks the actual path relative to output elsewhere; this
    # assertion is intentionally on artifact naming.
    assert viewer == Path("viewer.html")


def _test_bad_tile(root: Path, video: Path, log: Any) -> None:
    out = root / "bad-pack"
    generate_pack(
        str(video),
        PackConfig(
            output_dir=str(out),
            times="0,0.2,0.4,0.6",
            columns=2,
            rows_per_page=2,
            force_bad_slots={2},
        ),
    )
    report = verify_pack(str(out), video=str(video), check_pixels=False)
    codes = [e["code"] for e in report["errors"]]
    assert "TILE_MARKED_ERROR" in codes
    assert not any(c not in {"TILE_MARKED_ERROR"} for c in codes), codes
    m = json.loads((out / "manifest.json").read_text())
    bad = m["samples"][2]
    good_after = m["samples"][3]
    assert bad["status"] == "error"
    # The following slot remains at its deterministic grid cell.
    assert good_after["status"] == "ok"
    assert good_after["cellRect"]["x"] > bad["cellRect"]["x"] or good_after["cellRect"]["y"] > bad["cellRect"]["y"]
    log("✓ bad tile stays in its rectangle and does not shift other slots")


def _test_missing_page(src: Path, dst: Path, video: Path, log: Any) -> None:
    shutil.copytree(src, dst)
    page2 = dst / "pages" / "page_002.png"
    moved = dst / "pages" / "page_002_moved_away.png"
    page2.rename(moved)
    report = verify_pack(str(dst), video=str(video), check_pixels=False)
    missing = [e for e in report["errors"] if e["code"] == "PAGE_MISSING"]
    assert missing, "expected missing page error"
    affected_slots = {e.get("slot") for e in report["errors"] if e.get("code") == "PAGE_MISSING"}
    assert None in affected_slots  # one page-level diagnostic
    assert {s for s in affected_slots if s is not None} == set(range(10, 20)), affected_slots
    # Page 1 and 3 files still exist and should not produce missing errors.
    assert (dst / "pages" / "page_001.png").exists()
    assert (dst / "pages" / "page_003.png").exists()
    log("✓ moved page reports PAGE_MISSING for its slots; other pages remain inspectable")


def _test_outside_rect(src: Path, dst: Path, video: Path, log: Any) -> None:
    shutil.copytree(src, dst)
    manifest_path = dst / "manifest.json"
    m = json.loads(manifest_path.read_text())
    target = m["samples"][3]
    target["rect"]["width"] += 500
    manifest_path.write_text(json.dumps(m), encoding="utf-8")
    report = verify_pack(str(dst), video=str(video), check_pixels=False)
    outside = [e for e in report["errors"] if e["code"] == "RECT_OUTSIDE_IMAGE"]
    assert outside and outside[0].get("slot") == 3, report["errors"]
    log("✓ out-of-image rectangle reports exact slot and overflow reason")


def _test_vfr_offset(root: Path, log: Any) -> None:
    video = root / "vfr-offset.mp4"
    generate_sample(
        str(video), frame_count=18, width=240, height=136, vfr=True, start_offset=7.25
    )
    info = probe_video(str(video))
    assert info.is_vfr
    assert abs(info.origin_raw_pts - 7.25) < 0.08, info.origin_raw_pts
    assert abs(info.frames[0].time) < 1e-6

    out = root / "vfr-pack"
    m = generate_pack(
        str(video),
        PackConfig(output_dir=str(out), interval=0.31, columns=3, rows_per_page=2),
    )
    assert abs(m["timeline"]["originRawPtsTime"] - 7.25) < 0.08
    report = verify_pack(str(out), video=str(video), check_pixels=True)
    assert not report["errors"], report["errors"]
    log("✓ VFR and raw start offset normalize to the player's zero timeline")


def _test_portrait(root: Path, log: Any) -> None:
    video = root / "portrait.mp4"
    generate_sample(str(video), frame_count=12, width=180, height=320)
    out = root / "portrait-pack"
    m = generate_pack(
        str(video),
        PackConfig(output_dir=str(out), interval=0.45, columns=3, rows_per_page=2),
    )
    assert m["source"]["displayWidth"] == 180
    assert m["source"]["displayHeight"] == 320
    assert m["geometry"]["thumbHeight"] > m["geometry"]["thumbWidth"]
    report = verify_pack(str(out), video=str(video), check_pixels=True)
    assert not report["errors"], report["errors"]
    log("✓ portrait input chooses portrait thumbnails and verifies pixels")


def _test_rotation_metadata(root: Path, video: Path, log: Any) -> None:
    rotated = root / "rotation-metadata.mp4"
    ffmpeg = resolve_binary("ffmpeg")
    proc = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-display_rotation", "90", "-i", str(video),
            "-c", "copy", str(rotated),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise AssertionError(proc.stderr.decode("utf-8", "replace"))
    info = probe_video(str(rotated))
    assert info.rotation in (90, 270), info.rotation
    assert (info.display_width, info.display_height) == (info.height, info.width)

    out = root / "rotation-pack"
    manifest = generate_pack(
        str(rotated),
        PackConfig(output_dir=str(out), times="0,0.4,0.8", columns=3, rows_per_page=1),
    )
    assert manifest["geometry"]["thumbHeight"] > manifest["geometry"]["thumbWidth"]
    report = verify_pack(str(out), video=str(rotated), check_pixels=True)
    assert not report["errors"], report["errors"]
    log("✓ rotation metadata swaps preview aspect and FFmpeg autorotate pixels verify")


def _test_server(pack_dir: Path, video: Path, log: Any) -> None:
    server, url = serve_pack(pack_dir, video=video, port=0, open_browser=False)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            html = resp.read().decode("utf-8")
            assert resp.status == 200
            assert "__THUMB_PACK_MANIFEST_JSON__" not in html
            assert "thumb-pack@1" in html
        config_url = url.rsplit("/", 1)[0] + "/__thumb_pack/config.json"
        with urllib.request.urlopen(config_url, timeout=5) as resp:
            cfg = json.loads(resp.read())
            assert cfg["videoUrl"] == "/__thumb_pack/video"
        req = urllib.request.Request(
            config_url.replace("/config.json", "/video"), headers={"Range": "bytes=0-99"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read()
            assert resp.status == 206
            assert len(body) == 100
            assert resp.headers["Content-Range"].startswith("bytes 0-99/")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    log("✓ loopback viewer, config and HTTP Range video route work")


if __name__ == "__main__":
    import sys

    raise SystemExit(0 if run_selftest() else 1)
