"""End-to-end: build strips from real clips, save, verify, CLI round trip."""
import json

from slitscan.cli import main as cli_main
from slitscan.core import SlitConfig, build_strip
from slitscan.output import (load_manifest, manifest_blocks, save_result,
                             verify_pages)
from slitscan.video import decode_frames, probe


def _build(path, **kw):
    info = probe(path)
    frames, ts = decode_frames(path, info)
    cfg = SlitConfig(width=6, start_center=40, end_center=120, **kw)
    return info, frames, ts, build_strip(frames, ts, cfg)


def test_strip_from_constant_clip(sample_clips):
    info, frames, ts, result = _build(str(sample_clips["constant"]))
    assert verify_pages(result) == []
    assert result.frame_height == frames.shape[1]
    assert len(result.blocks) == len(ts)


def test_vfr_interval_layout_differs_from_frame_layout(sample_clips):
    path = str(sample_clips["vfr"])
    info = probe(path)
    frames, ts = decode_frames(path, info)
    per_frame = build_strip(frames, ts, SlitConfig(
        width=5, layout="frame", start_center=30, end_center=130))
    interval = build_strip(frames, ts, SlitConfig(
        width=5, layout="interval", interval=0.15,
        start_center=30, end_center=130))
    # the two layouts legitimately produce different time coverage
    assert per_frame.total_width != interval.total_width
    assert all(verify_pages(r) == [] for r in (per_frame, interval))


def test_save_and_reload_manifest_roundtrip(tmp_path, sample_clips):
    info, frames, ts, result = _build(str(sample_clips["constant"]),
                                      max_page_width=40)
    base = tmp_path / "strip.png"
    pages, mp = save_result(result, info.path, base)
    assert len(pages) == len(result.pages)
    manifest = load_manifest(mp)
    blocks = manifest_blocks(manifest)
    assert [b.to_dict() for b in result.blocks] == \
           [b.to_dict() for b in blocks]
    assert manifest["output"]["total_width"] == result.total_width
    # page png widths match manifest
    from PIL import Image
    for p, w in zip(pages, manifest["output"]["page_widths"]):
        assert Image.open(p).width == w


def test_cli_build_and_verify(tmp_path, sample_clips):
    out = tmp_path / "cli_strip.png"
    rc = cli_main([
        "build", str(sample_clips["constant"]), str(out),
        "--width", "16", "--start-center", "8", "--end-center", "140",
        "--padding", "edge", "--max-page-width", "120",
    ])
    assert rc == 0
    manifest_path = tmp_path / "cli_strip.manifest.json"
    assert manifest_path.exists()
    rc = cli_main(["verify", str(manifest_path), "--check-ids"])
    assert rc == 0


def test_cli_synth_and_verify_vfr(tmp_path):
    clip = tmp_path / "v.mp4"
    assert cli_main(["synth", "vfr", str(clip)]) == 0
    out = tmp_path / "vstrip.png"
    rc = cli_main(["build", str(clip), str(out), "--width", "5",
                   "--start-center", "10", "--end-center", "150",
                   "--layout", "interval", "--interval", "0.1"])
    assert rc == 0
    assert cli_main(["verify", str(tmp_path / "vstrip.manifest.json"),
                     "--check-ids"]) == 0


def test_verify_detects_manifest_tampering(tmp_path, sample_clips):
    info, frames, ts, result = _build(str(sample_clips["constant"]))
    _, mp = save_result(result, info.path, tmp_path / "s.png")
    manifest = json.loads(mp.read_text())
    # remove one block -> a coverage gap must be reported
    manifest["blocks"].pop(10)
    tampered = tmp_path / "bad.manifest.json"
    tampered.write_text(json.dumps(manifest))
    assert cli_main(["verify", str(tampered)]) == 1


def test_skip_interval_changes_block_count(sample_clips):
    path = str(sample_clips["constant"])
    frames, ts = decode_frames(path, probe(path))
    full = build_strip(frames, ts, SlitConfig(width=4))
    cut = build_strip(frames, ts, SlitConfig(
        width=4, skip_intervals=[(0.5, 1.5)]))
    assert len(cut.blocks) < len(full.blocks)
    assert all(not (0.5 <= b.t < 1.5) for b in cut.blocks)
    assert verify_pages(cut) == []


def test_limit_padding_keeps_every_column_real(sample_clips):
    path = str(sample_clips["reverse"])
    info = probe(path)
    frames, ts = decode_frames(path, info)
    # pan beyond both edges on purpose
    result = build_strip(frames, ts, SlitConfig(
        width=10, start_center=-20, end_center=info.width + 20,
        padding="limit"))
    for b in result.blocks:
        assert all(c >= 0 for c in b.source_cols)
        assert 0 <= b.slit_left <= info.width - 10
