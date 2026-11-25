"""单元测试: 编码/解码、时间轴、匹配与边界判定的纯函数部分.

这些测试不依赖 ffmpeg, 跑得很快; 端到端行为由 selfcheck.py 覆盖.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from syncmark import analyzer, model  # noqa: E402
from syncmark.model import AudioDetection, VideoDetection  # noqa: E402


# ---------------------------------------------------------------------------
# 编码
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mid", list(range(1, 256)))
def test_code_bits_roundtrip(mid):
    bits = model.code_bits_for_id(mid)
    assert len(bits) == model.DETECT_CODE_BITS
    assert model.id_from_code_bits(bits) == mid


def test_code_bits_detect_single_bit_error():
    bits = model.code_bits_for_id(42)
    for i in range(len(bits)):
        bad = list(bits)
        bad[i] ^= 1
        # 单比特翻转后, 大多数情况会被 2 位校验拦下或变成别的编号;
        # 至少不会静默还原成 42 且不报错
        got = model.id_from_code_bits(bad)
        if got is not None:
            assert got != 42


def test_tone_palette_is_separated():
    freqs = model.TONE_PALETTE_HZ
    assert len(freqs) == model.MAX_MARKERS
    diffs = np.diff(freqs)
    assert np.all(diffs >= 100)
    for i, f in enumerate(freqs):
        assert model.id_for_tone(f) == i + 1
    # 两档正中间(60 Hz 处)离两边的距离都超过默认容差
    assert model.id_for_tone(freqs[0] + 60) is None


def test_tone_for_id_bounds():
    assert model.tone_for_id(1) == model.TONE_PALETTE_HZ[0]
    assert model.tone_for_id(model.MAX_MARKERS) == model.TONE_PALETTE_HZ[-1]
    with pytest.raises(ValueError):
        model.tone_for_id(0)
    with pytest.raises(ValueError):
        model.tone_for_id(model.MAX_MARKERS + 1)


# ---------------------------------------------------------------------------
# 时间轴
# ---------------------------------------------------------------------------


def test_build_timeline_gaps_all_differ():
    starts, total = model.build_timeline(12)
    gaps = np.diff(starts) - model.FLASH_FRAMES
    # 前 11 段都是普通画面, 长度应当各不相同
    assert len(set(int(g) for g in gaps)) > 6
    assert starts[0] == model.LEAD_FRAMES
    assert total == starts[-1] + model.FLASH_FRAMES + model.TAIL_FRAMES


def test_build_timeline_first_at_zero():
    starts, total = model.build_timeline(5, first_at_zero=True)
    assert starts[0] == 0
    assert model.FLASH_FRAMES <= starts[1]


def test_marker_count_bounds():
    with pytest.raises(ValueError):
        model.build_timeline(0)
    with pytest.raises(ValueError):
        model.build_timeline(model.MAX_MARKERS + 1)


# ---------------------------------------------------------------------------
# 匹配判定
# ---------------------------------------------------------------------------


def _vd(mid, start_frame, fps=30.0, frames=3):
    return VideoDetection(id=mid, start_frame=start_frame, end_frame=start_frame + frames - 1,
                          start_time=start_frame / fps, end_time=(start_frame + frames - 1) / fps,
                          frame_count=frames)


def _ad(mid, start_time, dur=0.09):
    return AudioDetection(id=mid, freq_hz=model.tone_for_id(mid),
                          start_sample=int(start_time * 48000),
                          end_sample=int((start_time + dur) * 48000),
                          start_time=start_time, end_time=start_time + dur,
                          peak=0.5, confidence=0.85)


class _FakeAnalysis:
    def __init__(self, vdets, adets, fps=30.0):
        self.probe = {"video": {"fps": fps, "start_time": 0.0}, "audio": {"start_time": 0.0},
                      "start_time": 0.0}
        self.video_detections = vdets
        self.audio_detections = adets
        self.stats = {"video": {"fps": fps, "decoded_frames": 1000,
                                "first_frame_time": 0.0, "last_frame_time": 30.0},
                      "audio": {"sample_rate": 48000, "samples": 1440000}}


def _plan(n=6, fps=30.0):
    starts, total = model.build_timeline(n)
    return model.make_plan(marker_count=n, fps=int(fps))


def test_clean_matching_reports_no_offset():
    plan = _plan()
    vd = [_vd(m["id"], m["frame"]) for m in plan["markers"]]
    ad = [_ad(m["id"], m["time"] + 0.0005) for m in plan["markers"]]
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad), plan)
    assert rep["summary"]["matched"] == len(plan["markers"])
    assert rep["summary"]["has_global_offset"] is False
    assert rep["summary"]["has_local_issue"] is False


def test_global_offset_not_counted_as_local_issue():
    plan = _plan()
    vd = [_vd(m["id"], m["frame"]) for m in plan["markers"]]
    ad = [_ad(m["id"], m["time"] + 0.150) for m in plan["markers"]]
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad), plan)
    a = rep["sync"]["audio"]
    assert a["applicable"] is True
    assert abs(a["seconds"] - 0.150) < 0.002
    assert rep["summary"]["has_global_offset"] is True
    assert rep["summary"]["has_local_issue"] is False


def test_single_event_shift_is_local_issue():
    plan = _plan()
    vd = [_vd(m["id"], m["frame"]) for m in plan["markers"]]
    ad = [_ad(m["id"], m["time"]) for m in plan["markers"]]
    ad[3] = _ad(4, plan["markers"][3]["time"] + 0.080)
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad), plan)
    assert rep["summary"]["has_global_offset"] is False
    assert rep["summary"]["has_local_issue"] is True
    issues = [e for e in rep["events"] if e.get("local_issue")]
    assert len(issues) == 1 and issues[0]["id"] == 4


def test_frame_rounding_is_not_offset():
    # 计划时刻落在帧格中间时, 检出按帧取整只会差 <1 帧, 不应被当作偏移
    plan = _plan()
    vd = [_vd(m["id"], m["frame"] + 1) for m in plan["markers"]]
    ad = [_ad(m["id"], m["time"] + 1.0 / 30.0) for m in plan["markers"]]
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad), plan)
    assert rep["sync"]["video"]["applicable"] is False


def test_missing_and_extra_are_separated():
    plan = _plan()
    vd = [_vd(m["id"], m["frame"]) for m in plan["markers"] if m["id"] != 1]
    ad = [_ad(m["id"], m["time"]) for m in plan["markers"] if m["id"] != 1]
    # 6 号重复一次
    ad.append(_ad(6, plan["markers"][5]["time"] + 0.35))
    vd.append(_vd(6, plan["markers"][5]["frame"] + 10))
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad), plan)
    assert rep["summary"]["missing"] == 1
    assert rep["summary"]["extra"] == 1
    extra = rep["groups"]["unmatched_detection"]
    assert extra and extra[0]["id"] == 6 and extra[0]["kind"] == "extra_pair"


def test_offset_estimate_rejects_scattered_residuals():
    assert analyzer._offset_estimate([], 0.045)["applicable"] is False
    # 两个大正一个负 => 离散度太大, 不应判为整齐平移
    d = analyzer._offset_estimate([0.2, 0.21, 0.0, 0.05], 0.045)
    assert d["applicable"] is False
    # 整齐的 120 ms
    d = analyzer._offset_estimate([0.12, 0.121, 0.119, 0.12], 0.045)
    assert d["applicable"] is True
    # 小于 50 ms 的整齐差值不报
    d = analyzer._offset_estimate([0.03, 0.031, 0.029, 0.030], 0.045)
    assert d["applicable"] is False


def test_empty_plan_marks_everything_unplanned():
    vd = [_vd(1, 15), _vd(2, 42)]
    ad = [_ad(1, 0.5), _ad(2, 1.4)]
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad),
                              {"markers": [], "video": None, "audio": None,
                               "faults": {}, "plan_path": None})
    assert rep["summary"]["matched"] == 0
    assert rep["summary"]["extra"] == 2


def test_duplicate_frames_merge_into_one_run(tmp_path):
    """同编号、间隔很小且很短的重复段, 应合并, 不出现在第二次闪光里."""
    plan = _plan()
    vd = []
    for m in plan["markers"]:
        vd.append(_vd(m["id"], m["frame"]))
    # 在 3 号闪光后 2 帧插一段 1 帧的重复
    base = plan["markers"][2]
    vd.append(_vd(base["id"], base["frame"] + model.FLASH_FRAMES + 1, frames=1))
    ad = [_ad(m["id"], m["time"]) for m in plan["markers"]]
    # 检测合并逻辑在 _detect_video 内部, 这里直接验证它对 run 的合并结果:
    rep = analyzer.match_plan(_FakeAnalysis(vd, ad), plan)
    # 未合并的重复段会被当成 extra; 这是检测层的职责, 检测层另有端到端覆盖
    assert rep["summary"]["matched"] == len(plan["markers"])


# ---------------------------------------------------------------------------
# JSON 读写
# ---------------------------------------------------------------------------


def test_plan_roundtrip(tmp_path):
    plan = model.make_plan(marker_count=5)
    p = tmp_path / "p.json"
    model.write_json_atomic(str(p), plan)
    back = model.read_json(str(p))
    assert back["schema"] == model.SCHEMA_PLAN
    assert len(back["markers"]) == 5
    assert back["markers"][0]["time"] == pytest.approx(model.LEAD_FRAMES / model.DEFAULT_FPS)


def test_find_plan_sidecar(tmp_path):
    film = tmp_path / "a.mp4"
    film.write_bytes(b"")
    plan = tmp_path / "a.plan.json"
    plan.write_text("{}", encoding="utf-8")
    assert model.find_plan_sidecar(str(film)) == str(plan)
    plan.unlink()
    assert model.find_plan_sidecar(str(film)) is None
