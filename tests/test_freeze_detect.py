"""pytest 用例：核心算法、时间轴、标注持久化与导出。

运行：``python -m pytest -q``
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np
import pytest

from freeze_detect.annotations import AnnotationStore, export_report
from freeze_detect.config import DetectionParams
from freeze_detect.detect import analyze, format_timecode
from freeze_detect.sample import generate_sample
from freeze_detect.timeline import FFmpegError, read_timeline, require_binary


@pytest.fixture(scope="session")
def sample(tmp_path_factory):
    try:
        require_binary("ffmpeg")
        require_binary("ffprobe")
    except FFmpegError as exc:  # pragma: no cover - 环境缺依赖
        pytest.skip(str(exc))
    out = tmp_path_factory.mktemp("sample")
    return generate_sample(str(out))


@pytest.fixture(scope="session")
def sample_result(sample):
    return analyze(sample["timeline"], DetectionParams())


def test_sample_is_vfr_with_exact_timings(sample):
    tl = sample["timeline"]
    truth = sample["truth_data"]
    assert truth["is_vfr"] is True
    assert tl.is_vfr is True
    # 所有帧的展示时长都来自容器
    assert tl.timing_exact_count() == tl.frame_count
    # 逐帧时长互不相等（不是恒定帧率）
    durations = {round(d * 1000) for d in tl.durations}
    assert len(durations) > 2
    assert truth["duration_ms"] == int(round(tl.duration * 1000))
    # 首帧时长与真值一致
    assert abs(tl.durations[0] * 1000 - 33) <= 1


def test_detects_inserted_freezes_and_excludes_slow_change(sample_result, sample):
    tl = sample["timeline"]
    truth = {e["name"]: e for e in sample["truth_data"]["segments"]}
    hits = {
        (s.start_frame, s.end_frame): s for s in sample_result.segments
    }
    for name in ("head_freeze", "insert_freeze", "tail_freeze"):
        exp = truth[name]
        key = (exp["start_frame"], exp["end_frame"])
        assert key in hits, f"{name} 未检出，实际 {list(hits)}"
        seg = hits[key]
        assert seg.start_ms == exp["start_ms"]
        assert seg.end_ms == exp["end_ms"]
        assert seg.duration_ms == exp["duration_ms"]

    # 慢速变化不能被当成冻结
    slow = truth["slow_change"]
    for seg in sample_result.segments:
        if seg.auto_kind != "freeze":
            continue
        assert not (
            seg.start_frame <= slow["end_frame"]
            and seg.end_frame >= slow["start_frame"]
        ), f"慢速变化被误判: {seg.start_frame}-{seg.end_frame}"

    # 短于阈值的停顿不能检出
    short = truth["short_freeze"]
    for seg in sample_result.segments:
        assert not (
            seg.start_frame <= short["end_frame"]
            and seg.end_frame >= short["start_frame"]
        )


def test_head_and_tail_ranges_use_real_frame_durations(sample_result, sample):
    tl = sample["timeline"]
    head = next(s for s in sample_result.segments if s.start_frame == 0)
    assert head.start_time == pytest.approx(0.0, abs=1e-6)
    assert head.end_time == pytest.approx(tl.frame_end(head.end_frame), abs=1e-6)

    tail = next(
        s for s in sample_result.segments if s.end_frame == tl.frame_count - 1
    )
    assert tail.end_time == pytest.approx(tl.frame_end(tl.frame_count - 1), abs=1e-6)
    # 结尾帧的时长必须来自容器，而不是按恒定帧率去推算
    assert tail.end_time - tail.start_time == pytest.approx(
        sum(tl.durations[tail.start_frame : tail.end_frame + 1]), abs=1e-6
    )


def test_context_frames_are_reported(sample_result):
    for seg in sample_result.segments:
        assert len(seg.context_before) <= 4
        assert len(seg.context_after) <= 4
        for f in seg.context_before:
            assert f.index < seg.start_frame
        for f in seg.context_after:
            assert f.index > seg.end_frame


def test_static_and_black_are_classified(sample_result):
    kinds = {s.auto_kind for s in sample_result.segments}
    assert "static" in kinds
    assert "black" in kinds


def test_annotations_survive_recheck(sample, sample_result, tmp_path):
    video = sample["video"]
    store = AnnotationStore.load(video)
    static = next(s for s in sample_result.segments if s.auto_kind == "static")
    black = next(s for s in sample_result.segments if s.auto_kind == "black")
    freeze = next(
        s for s in sample_result.segments
        if s.auto_kind == "freeze" and s.start_frame > 0
    )
    store.set(static, "static", "静态画面跳过")
    store.set(black, "black", "黑场跳过")
    store.set(freeze, "", "疑似卡顿")
    store.save(video, sample_result)

    # 换参数复检（段边界可能变化），标注必须能迁移到新段上
    stricter = DetectionParams(
        similarity=0.998, min_duration_ms=600, drift_tolerance=0.004
    )
    recheck = analyze(sample["timeline"], stricter)
    store2 = AnnotationStore.load(video)
    hits = store2.apply(recheck.segments)
    assert hits >= 3, [(s.start_ms, s.end_ms, s.label) for s in recheck.segments]

    labels = {s.label for s in recheck.segments}
    assert "static" in labels
    assert "black" in labels
    for seg in recheck.segments:
        if seg.label in ("static", "black", "skip"):
            assert seg.ignored
    # 人工记为"正常冻结"的段不应被忽略
    noted = [s for s in recheck.segments if s.note == "疑似卡顿"]
    assert noted and all(not s.ignored for s in noted)

    data = json.loads(open(store2.path, encoding="utf-8").read())
    assert isinstance(data["segments"], dict)
    assert any(v["label"] == "static" for v in data["segments"].values())


def test_export_csv_json_and_snapshots(sample_result, tmp_path):
    out = tmp_path / "report"
    paths = export_report(sample_result, str(out), snapshots=True, clips=False)
    assert os.path.exists(paths["csv"])
    assert os.path.exists(paths["json"])
    assert len(paths["snapshots"]) >= len(sample_result.segments)

    with open(paths["csv"], encoding="utf-8-sig") as fh:
        header = fh.readline()
    assert "开始(ms)" in header and "时长(ms)" in header

    data = json.loads(open(paths["json"], encoding="utf-8").read())
    assert data["is_vfr"] is True
    assert len(data["segments"]) == len(sample_result.segments)
    first = data["segments"][0]
    assert set(first) >= {"start_ms", "end_ms", "duration_ms", "context_before"}

    for path in paths["snapshots"]:
        assert os.path.getsize(path) > 1024


def test_single_held_frame_is_found(tmp_path):
    """某帧被展示很久（内容与邻居相同、时间间隔大）也要算冻结。"""
    require_binary("ffmpeg")
    # 12 帧内容各不同，第 5 帧的展示时长是 400ms
    pts = [0, 33, 66, 99, 132, 165, 565, 598, 631, 664, 697, 730, 763]
    w, h = 160, 90
    frames = []
    for i in range(12):
        frame = np.zeros((h, w, 3), np.uint8)
        frame[:, :, 0] = (np.arange(w)[None, :] + i * 37) % 256
        frame[:, :, 1] = (np.arange(h)[:, None] + i * 53) % 256
        frame[:, :, 2] = (i * 19) % 256
        frames.append(frame)
    frames.append(frames[-1])
    expr = "+".join(f"if(eq(N,{i}),{p})" for i, p in enumerate(pts))
    out = tmp_path / "held.mp4"
    cmd = [
        "ffmpeg", "-hide_banner", "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
        "-framerate", "1000", "-i", "pipe:0",
        "-vf", f"setpts='({expr})/1000/TB'",
        "-fps_mode", "passthrough", "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-bf", "0",
        "-enc_time_base", "1/90000", "-video_track_timescale", "90000",
        str(out),
    ]
    subprocess.run(cmd, input=b"".join(f.tobytes() for f in frames), check=True)
    tl = read_timeline(str(out))
    assert tl.durations[5] == pytest.approx(0.399, abs=0.002)
    result = analyze(tl, DetectionParams())
    held = [s for s in result.segments if s.single_held_frame]
    assert len(held) == 1
    seg = held[0]
    assert seg.start_frame == 5 and seg.end_frame == 5
    assert seg.duration_ms == pytest.approx(399, abs=2)
    assert seg.start_ms == 165 and seg.end_ms == 564


def test_timeline_handles_missing_frame_durations(tmp_path):
    """逐帧 duration 缺失时，用相邻 PTS 补齐。"""
    require_binary("ffmpeg")
    out = tmp_path / "nocfr.mp4"
    # 交错时长：mkv 封装下 ffprobe 的 frame duration 不一定存在
    cmd = [
        "ffmpeg", "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=0.6",
        "-vf", "setpts='PTS+if(gte(N,5),0.05,0)'",
        "-fps_mode", "passthrough", "-c:v", "libx264", "-crf", "20",
        "-pix_fmt", "yuv420p", str(out),
    ]
    subprocess.run(cmd, check=True)
    tl = read_timeline(str(out))
    assert tl.frame_count >= 12
    assert all(d > 0 for d in tl.durations)
    assert tl.frame_end(tl.frame_count - 1) > tl.pts[-1]


@pytest.mark.parametrize(
    "value,expected",
    [(0.0, "00:00:00.000"), (1.234, "00:00:01.234"), (3661.5, "01:01:01.500")],
)
def test_timecode_format(value, expected):
    assert format_timecode(value) == expected


def test_params_validation():
    with pytest.raises(ValueError):
        DetectionParams(similarity=1.5)
    with pytest.raises(ValueError):
        DetectionParams(min_duration_ms=-1)
    with pytest.raises(ValueError):
        DetectionParams(context_before=-2)
    params = DetectionParams(similarity=0.99)
    assert params.distance_threshold == pytest.approx(0.01)
    assert params.effective_drift_tolerance == pytest.approx(0.025)
    explicit = DetectionParams(similarity=0.99, drift_tolerance=0.4)
    assert explicit.effective_drift_tolerance == 0.4
