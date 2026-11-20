"""自动验证套件: 用已知时间关系的合成素材检验对齐核心.

所有断言都基于生成素材时写下的精确映射 (manifest.json), 不依赖人工听感。

运行:
    .venv/bin/python verify.py          # 简洁报告 + 退出码
    .venv/bin/pytest -q                 # 完整 pytest
"""

from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest
import soundfile as sf
from scipy import signal

from dualalign.align import Anchor, AnchorConflictError, AlignmentError, analyze
from dualalign.audio import AudioClip, AudioLoadError, load_wav
from dualalign.engine import AudioEngine, NullSink, PlaybackError
from dualalign.export import (
    export_result,
    load_exported,
    verify_export,
)
from dualalign.features import extract_features
from dualalign.render import position_consistency, render_reference_compare
from dualalign.samples import SampleSpec, generate_all

SAMPLE_DIR = Path(__file__).resolve().parent / "sample_data"


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def samples(tmp_path_factory) -> dict:
    folder = tmp_path_factory.mktemp("samples")
    manifests = generate_all(folder)
    return {
        "folder": folder,
        **manifests,
    }


@pytest.fixture(scope="session")
def demo(samples) -> dict:
    m = samples["demo"]
    folder = samples["folder"]
    ref = load_wav(folder / m.files["reference"], "reference")
    take = load_wav(folder / m.files["take"], "take")
    result = analyze(ref, take)
    return {"manifest": m, "ref": ref, "take": take, "result": result, "folder": folder}


@pytest.fixture(scope="session")
def repeat_case(samples) -> dict:
    m = samples["repeat_heavy"]
    folder = samples["folder"]
    ref = load_wav(folder / m.files["reference"], "reference")
    take = load_wav(folder / m.files["take"], "take")
    result = analyze(ref, take)
    return {"manifest": m, "ref": ref, "take": take, "result": result, "folder": folder}


def _best_lag_ms(a: np.ndarray, b: np.ndarray, sr: int) -> tuple[float, float]:
    """返回 (b 相对 a 的最佳滞后毫秒, 归一化互相关峰值)。"""

    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a - a.mean()
    b = b - b.mean()
    if np.linalg.norm(a) < 1e-9 or np.linalg.norm(b) < 1e-9:
        return float("nan"), 0.0
    corr = signal.correlate(b, a, mode="full", method="fft")
    lags = signal.correlation_lags(len(b), len(a), mode="full")
    k = int(np.argmax(corr))
    peak = float(corr[k] / (np.linalg.norm(a) * np.linalg.norm(b)))
    return float(lags[k]) / sr * 1000.0, peak


def _envelope_lag_ms(a: np.ndarray, b: np.ndarray, sr: int, rate: int = 100) -> tuple[float, float]:
    """按 100 Hz 能量包络估计 b 相对 a 的滞后, 对波形相位/漂移不敏感。

    用于核对"同一参考时间轴上位置一致"; 比原始波形互相关稳健得多。
    """

    win = max(1, sr // rate)

    def env(sig: np.ndarray) -> np.ndarray:
        sig = np.asarray(sig, dtype=np.float64)
        power = np.convolve(sig ** 2, np.ones(win) / win, mode="same")
        return np.sqrt(power)[::win]

    ea = env(a)
    eb = env(b)
    n = min(len(ea), len(eb))
    ea, eb = ea[:n] - ea[:n].mean(), eb[:n] - eb[:n].mean()
    if np.linalg.norm(ea) < 1e-12 or np.linalg.norm(eb) < 1e-12:
        return float("nan"), 0.0
    corr = signal.correlate(eb, ea, mode="full", method="fft")
    lags = signal.correlation_lags(n, n, mode="full")
    k = int(np.argmax(corr))
    peak = float(corr[k] / (np.linalg.norm(ea) * np.linalg.norm(eb)))
    return float(lags[k]) / rate * 1000.0, peak


def _truth_pairs(manifest, min_ref: float = 0.0, max_take: float | None = None):
    pairs = []
    for row in manifest.mapping:
        if row["take_s"] is None:
            continue
        if row["ref_s"] < min_ref:
            continue
        if max_take is not None and row["take_s"] > max_take:
            continue
        pairs.append((float(row["ref_s"]), float(row["take_s"])))
    return pairs


# ---------------------------------------------------------------------------
# 素材生成: 已知关系本身必须自洽
# ---------------------------------------------------------------------------


def test_manifest_self_consistent(samples) -> None:
    m = samples["demo"]
    assert m.files["reference_sample_rate"] != m.files["take_sample_rate"]
    assert m.expected_start_offset_s > 1.0
    # 末端漂移至少 0.2 秒, 否则"缓慢漂移"不成立
    assert abs(m.expected_end_drift_s) > 0.2
    # 参考素材必须包含非重复内容与重复节奏段落
    assert m.spec["repeated_region_s"][1] - m.spec["repeated_region_s"][0] >= 5.0
    assert len(m.spec["silence_ref_s"]) >= 1
    # 映射单调
    takes = [r["take_s"] for r in m.mapping if r["take_s"] is not None]
    assert all(b > a for a, b in zip(takes, takes[1:]))
    # 缺失区间在映射里确实为空
    for a, b in m.missing_ref_regions:
        rows = [r for r in m.mapping if a <= r["ref_s"] < b]
        if rows:
            assert all(r["take_s"] is None for r in rows)


def test_reference_is_not_single_impulse(samples) -> None:
    """参考素材不能只是容易匹配的单个脉冲。"""

    from dualalign.samples import synthesize_reference

    spec = SampleSpec(ref_duration_s=45.0)
    reference, events = synthesize_reference(spec)
    kinds = {e["kind"] for e in events}
    assert len(kinds) >= 4, kinds
    assert len(events) > 40
    # 每个声事件时长各异 (非重复脉冲)
    durations = {round(e["duration_s"], 3) for e in events if e["kind"] != "motif"}
    assert len(durations) >= 10
    # 至少有 3 个不同的频谱内容可通过特征区分
    feat = extract_features(AudioClip(Path("ref"), reference, 48_000, "reference"))
    assert feat.frames > 1000


# ---------------------------------------------------------------------------
# 对齐核心
# ---------------------------------------------------------------------------


def test_known_start_offset(demo) -> None:
    m, result = demo["manifest"], demo["result"]
    start = m.expected_start_offset_s
    # 起点偏移: 待对齐录音在参考 start 秒之前没有声音
    lead = [g for g in result.gaps if g.kind == "lead_in"]
    assert len(lead) == 1
    assert abs(lead[0].ref_end - start) < 0.10, (lead[0].ref_end, start)
    # 该区间导出静音
    assert lead[0].duration > 1.0
    # 起点附近映射误差
    pairs = _truth_pairs(m, min_ref=start + 1.0, max_take=5.0)
    errors = [float(result.curve.take_time_at(r)) - t for r, t in pairs]
    assert max(abs(e) for e in errors) < 0.030, errors


def test_drift_trend_reported(demo) -> None:
    result = demo["result"]
    assert result.trend.overall_drift_percent is not None
    # 已知基础速度 1.009 (+ 末端额外漂移) => 待对齐时间/参考时间 ≈ 0.99
    assert -1.6 < result.trend.overall_drift_percent < -0.6
    assert len(result.trend.segments) >= 2  # 缺失前后的分段
    # 前后段都应报告漂移
    for seg in result.trend.segments:
        assert abs(seg["drift_percent"]) > 0.3
    # 取样点显示随时间累积的偏差 (非恒定起点偏移)
    deviations = [abs(s["deviation_from_constant_offset_ms"]) for s in result.trend.samples]
    assert max(deviations) > 50.0, deviations


def test_drift_end_error_small(demo) -> None:
    """漂移末端误差: 参考后段的对齐误差必须远小于未修正的累积漂移。"""

    m, result = demo["manifest"], demo["result"]
    ref_end = m.end_ref_s
    # 未修正时, 末端累积漂移约 |expected_end_drift_s| 秒
    uncorrected = abs(m.expected_end_drift_s)
    assert uncorrected > 0.2
    pairs = _truth_pairs(m, min_ref=ref_end - 12.0)
    assert pairs, "后段没有参考点"
    errors = [abs(float(result.curve.take_time_at(r)) - t) for r, t in pairs]
    assert max(errors) < 0.030, (max(errors), uncorrected)
    # 明确优于"只用一个整体起点偏移"
    body = _truth_pairs(m, min_ref=m.expected_start_offset_s + 1.0, max_take=15.0)
    offset_errors = [abs((r - m.expected_start_offset_s - t)) for r, t in body]
    assert max(errors) < 0.5 * max(offset_errors)


def test_missing_region_detected_and_not_stretched(demo) -> None:
    m, result = demo["manifest"], demo["result"]
    (true_a, true_b), = m.missing_ref_regions
    missing = [g for g in result.gaps if g.kind == "missing"]
    assert len(missing) == 1, missing
    gap = missing[0]
    assert abs(gap.ref_start - true_a) < 0.20, (gap.ref_start, true_a)
    assert abs(gap.ref_end - true_b) < 0.20, (gap.ref_end, true_b)
    # 缺失区间内待对齐时间保持恒定 (不拉伸)
    before = float(result.curve.take_time_at(gap.ref_start + 0.05))
    after = float(result.curve.take_time_at(gap.ref_end - 0.05))
    assert abs(after - before) < 0.01, (before, after)
    # 缺失前后都有合理对应关系
    pre = _truth_pairs(m, min_ref=true_a - 3.0, max_take=float(result.curve.take_time_at(true_a)) - 0.1)
    post = _truth_pairs(m, min_ref=true_b + 0.5)
    for pairs in (pre, post):
        assert pairs
        errs = [abs(float(result.curve.take_time_at(r)) - t) for r, t in pairs]
        assert max(errs) < 0.040, max(errs)


def test_missing_region_exports_as_silence(demo) -> None:
    result = demo["result"]
    gap = [g for g in result.gaps if g.kind == "missing"][0]
    out, sr = render_reference_compare(result, "aligned", gap.ref_start + 0.1, gap.ref_end - 0.1)
    assert float(np.max(np.abs(out))) < 1e-6
    # 有效区间必须明确列出
    assert result.coverage_regions
    for a, b in result.coverage_regions:
        assert b > a
    # 缺失区间不在有效区间内
    for a, b in result.coverage_regions:
        assert not (a < gap.ref_start + 0.01 and b > gap.ref_end - 0.01)


def test_low_confidence_regions_flagged(repeat_case) -> None:
    m, result = repeat_case["manifest"], repeat_case["result"]
    assert result.low_confidence, "重复节奏素材应给出置信不足区间"
    # 至少覆盖一段重复节奏区域
    rep0, rep1 = m.spec["repeated_region_s"]
    covered = [
        r for r in result.low_confidence
        if r.ref_start < rep1 and r.ref_end > rep0
    ]
    assert covered, [r.as_dict() for r in result.low_confidence]


def test_manual_anchor_updates_neighbours(demo) -> None:
    result = demo["result"]
    ref_t = 15.0
    base = float(result.curve.take_time_at(ref_t))
    updated = result.with_anchors([Anchor(ref_t, base + 0.20, "test")])
    assert abs(float(updated.curve.take_time_at(ref_t)) - (base + 0.20)) < 1e-3
    # 相邻位置随之变化, 远端基本不变
    assert abs(float(updated.curve.take_time_at(ref_t + 1.0))
               - float(result.curve.take_time_at(ref_t + 1.0))) > 0.02
    assert abs(float(updated.curve.take_time_at(40.0))
               - float(result.curve.take_time_at(40.0))) < 0.05
    # 自动曲线未被破坏
    assert abs(float(result.curve.take_time_at(ref_t)) - base) < 1e-9
    # 删除锚点恢复自动结果
    restored = updated.with_anchors([])
    assert abs(float(restored.curve.take_time_at(ref_t)) - base) < 1e-6


def test_anchor_conflict_rejected(demo) -> None:
    result = demo["result"]
    # 时间顺序冲突: 后一个参考时间对应更早的待对齐时间
    with pytest.raises(AnchorConflictError):
        result.with_anchors([Anchor(10.0, 20.0), Anchor(20.0, 5.0)])
    # 锚点落在缺失区间内
    gap = [g for g in result.gaps if g.kind == "missing"][0]
    with pytest.raises(AnchorConflictError):
        result.with_anchors([Anchor(0.5 * (gap.ref_start + gap.ref_end), 21.0)])
    # 过大的时间伸缩: 会要求相邻区间倒流/停滞
    with pytest.raises(AnchorConflictError):
        result.with_anchors([Anchor(41.0, 2.0)])
    # 拒绝之后原结果不变
    assert result.anchors == []
    assert np.all(np.diff(result.curve.knots_take) >= -1e-9)


def test_curve_always_monotonic(demo) -> None:
    result = demo["result"]
    candidates = [
        [Anchor(8.0, float(result.curve.take_time_at(8.0)) + 0.3)],
        [Anchor(8.0, float(result.curve.take_time_at(8.0)) + 0.3),
         Anchor(30.0, float(result.curve.take_time_at(30.0)) - 0.3)],
        [Anchor(5.0, 4.6), Anchor(15.0, 13.8), Anchor(35.0, 31.3)],
    ]
    for anchors in candidates:
        updated = result.with_anchors(anchors)
        assert np.all(np.diff(updated.curve.knots_ref) > 0)
        assert np.all(np.diff(updated.curve.knots_take) >= -1e-9)
        # 任何参考时间下都不倒流
        ts = np.linspace(0, result.ref_duration, 2000)
        vals = updated.curve.take_time_at(ts)
        assert np.all(np.diff(vals) >= -1e-6)


# ---------------------------------------------------------------------------
# 导出与再次打开
# ---------------------------------------------------------------------------


def test_export_length_and_roles(demo, tmp_path) -> None:
    result = demo["result"]
    summary, wav, desc = export_result(result, tmp_path / "aligned.wav")
    info = sf.info(str(wav))
    assert info.frames == demo["ref"].frames
    assert info.samplerate == demo["ref"].sample_rate
    assert info.channels == demo["ref"].channels
    payload = load_exported(desc)
    assert payload["output_timeline"] == "reference"
    assert payload["take"]["original_sha256"] == result.take_clip.file_sha256()
    # 说明里包含人工锚点、缺失区间与有效范围
    assert "anchors" in payload and "gaps" in payload and "valid_sound_regions_s" in payload
    # 原始文件没有被改动
    assert result.take_clip.file_sha256() == demo["manifest"].files["take_sha256"]


def test_export_not_original_copy(demo, tmp_path) -> None:
    """导出必须是漂移修正后的结果, 而不是原文件拷贝。

    以 1 秒能量包络比较位置: 包络对 10 ms 级相位误差不敏感, 只反映
    真正的错位。未修正的待对齐录音后段会错开约 0.4 秒。
    """

    result = demo["result"]
    _, wav, _ = export_result(result, tmp_path / "aligned.wav")
    data, sr = sf.read(str(wav), dtype="float64", always_2d=True)
    ref = result.ref_clip.samples
    take = result.take_clip.samples
    take_sr = result.take_clip.sample_rate
    late = int(38.0 * sr)
    span = int(1.0 * sr)
    lag, corr = _envelope_lag_ms(ref[late:late + span, 0], data[late:late + span, 0], sr)
    assert abs(lag) <= 10.0 and corr > 0.95, (lag, corr)
    drift_s = demo["manifest"].expected_end_drift_s
    assert abs(drift_s) > 0.2
    idx = np.arange(late, late + span) / sr * take_sr
    naive = np.interp(idx, np.arange(take.shape[0]), take[:, 0])
    lag_naive, corr_naive = _envelope_lag_ms(ref[late:late + span, 0], naive, sr)
    assert corr_naive < 0.8 or abs(lag_naive) > 100.0, (lag_naive, corr_naive)


def test_reopen_matches_preview(demo, tmp_path) -> None:
    result = demo["result"]
    summary, wav, desc = export_result(result, tmp_path / "aligned.wav")
    report = position_consistency(result, wav, tolerance_ms=2.0)
    assert report["ok"], report
    verification = verify_export(desc)
    assert verification["ok"], verification["checks"]
    # 再加一个人工锚点后重新导出, 位置仍然一致
    anchor = Anchor(15.0, float(result.curve.take_time_at(15.0)) + 0.15)
    updated = result.with_anchors([anchor])
    summary2, wav2, desc2 = export_result(updated, tmp_path / "aligned2.wav")
    report2 = position_consistency(updated, wav2, tolerance_ms=2.0)
    assert report2["ok"], report2
    payload = load_exported(desc2)
    assert payload["anchors"], payload["anchors"]


def test_export_silence_and_valid_regions(demo, tmp_path) -> None:
    result = demo["result"]
    summary, wav, _ = export_result(result, tmp_path / "aligned.wav")
    data, sr = sf.read(str(wav), dtype="float64", always_2d=True)
    for gap in result.gaps:
        a, b = int(gap.ref_start * sr) + 10, int(gap.ref_end * sr) - 10
        if b - a < 100:
            continue
        assert float(np.max(np.abs(data[a:b]))) < 1e-5, gap.as_dict()
    assert summary.valid_regions
    for a, b in summary.valid_regions:
        mid = int(0.5 * (a + b) * sr)
        span = int(0.2 * sr)
        assert float(np.sqrt(np.mean(data[mid:mid + span] ** 2))) > 1e-4


# ---------------------------------------------------------------------------
# 试听失效
# ---------------------------------------------------------------------------


def test_playback_uses_same_reference_axis(demo) -> None:
    result = demo["result"]
    # 左声道 (参考) 与右声道 (对齐结果) 取自同一参考时间区间:
    # 用能量包络核对位置 (对波形相位不敏感)
    for start, end in ((9.0, 11.0), (26.0, 30.0), (30.0, 32.0), (36.0, 40.0)):
        left, sr = render_reference_compare(result, "reference", start, end)
        right, _ = render_reference_compare(result, "aligned", start, end)
        assert left.shape == right.shape
        lag, corr = _envelope_lag_ms(left[:, 0], right[:, 0], sr)
        assert abs(lag) <= 10.0, (start, end, lag)
        assert corr > 0.9, (start, end, corr)


def test_playback_invalidated_on_change(demo) -> None:
    result = demo["result"]
    sink = NullSink()
    engine = AudioEngine(sink)
    engine.set_result(result)
    clip = engine.play(9.0, 11.0)
    assert engine.is_current(clip)
    assert sink.played and sink.played[-1] is clip
    # 切换区间 -> 旧片段失效
    clip2 = engine.play(15.0, 17.0)
    assert not engine.is_current(clip)
    assert engine.is_current(clip2)
    with pytest.raises(PlaybackError):
        engine.play_with(clip)
    # 停止 -> 失效
    engine.stop()
    assert engine.current is None
    with pytest.raises(PlaybackError):
        engine.play_with(clip2)
    # 重新分析 -> 失效
    clip3 = engine.play(5.0, 7.0)
    engine.set_result(result)
    assert not engine.is_current(clip3)
    # 锚点变化 -> 失效
    engine.set_result(result)
    updated = result.with_anchors([Anchor(12.0, float(result.curve.take_time_at(12.0)) + 0.1)])
    engine.set_result(updated, "12.0:10.0")
    clip4 = engine.play(12.0, 14.0)
    engine.update_anchors_signature("12.0:10.5")
    assert not engine.is_current(clip4)
    engine.stop()


def test_playback_gap_silent(demo) -> None:
    result = demo["result"]
    gap = [g for g in result.gaps if g.kind == "missing"][0]
    out, sr = render_reference_compare(result, "aligned", gap.ref_start - 0.2, gap.ref_end + 0.2)
    a = int(0.3 * sr)
    b = len(out) - int(0.3 * sr)
    assert float(np.max(np.abs(out[a:b]))) < 1e-5


def test_playback_rejects_invalid_range(demo) -> None:
    sink = NullSink()
    engine = AudioEngine(sink)
    engine.set_result(demo["result"])
    with pytest.raises(PlaybackError):
        engine.play(10.0, 10.1)
    with pytest.raises(PlaybackError):
        engine.play(-1.0, 2.0)
    with pytest.raises(PlaybackError):
        engine.play(0.0, demo["result"].ref_duration + 1.0)


def test_playback_modes_and_mode_switch(demo) -> None:
    from dualalign.playback import build_ab_clip

    result = demo["result"]
    ab = build_ab_clip(result, 9.0, 11.0, token=1, mode="ab")
    ref_only = build_ab_clip(result, 9.0, 11.0, token=2, mode="reference")
    aligned_only = build_ab_clip(result, 9.0, 11.0, token=3, mode="aligned")
    assert ab.mode == "ab" and ref_only.mode == "reference" and aligned_only.mode == "aligned"
    # 参考模式两声道相同; 对齐模式两声道相同; 且与 A/B 左/右分别一致
    assert np.allclose(ref_only.stereo[:, 0], ref_only.stereo[:, 1])
    assert np.allclose(aligned_only.stereo[:, 0], aligned_only.stereo[:, 1])
    assert np.allclose(ref_only.stereo[:, 0], ab.stereo[:, 0])
    assert np.allclose(aligned_only.stereo[:, 0], ab.stereo[:, 1])
    # 切换模式必须让旧片段失效
    engine = AudioEngine(NullSink())
    engine.set_result(result)
    clip = engine.play(9.0, 11.0, mode="ab")
    clip2 = engine.play(9.0, 11.0, mode="reference")
    assert not engine.is_current(clip) and engine.is_current(clip2)
    engine.stop()


def test_reopen_exported_reproduces_positions(demo, tmp_path) -> None:
    from dualalign.export import reopen_exported

    result = demo["result"]
    updated = result.with_anchors([Anchor(15.0, float(result.curve.take_time_at(15.0)) + 0.15, "x")])
    summary, wav, desc = export_result(updated, tmp_path / "aligned.wav")
    ref, take, reopened, payload = reopen_exported(desc, search_dirs=[demo["folder"]])
    assert len(reopened.anchors) == 1
    xs = np.linspace(0.0, updated.ref_duration, 800)
    diff_ms = np.max(np.abs(reopened.curve.take_time_at(xs) - updated.curve.take_time_at(xs))) * 1000
    assert diff_ms < 1.0, diff_ms
    assert position_consistency(reopened, wav, tolerance_ms=2.0)["ok"]


def test_no_mixing_api() -> None:
    from dualalign.engine import MixingNotSupported, reject_mixing

    with pytest.raises(MixingNotSupported):
        reject_mixing(gain=2.0)
    # 公开模块里不存在音量/包络处理函数
    import dualalign.render as render

    public = {name for name in dir(render) if not name.startswith("_")}
    assert not any(key in public for key in ("mix", "apply_gain", "volume_envelope"))


# ---------------------------------------------------------------------------
# 边界条件
# ---------------------------------------------------------------------------


def test_audio_load_rejects_long_file(tmp_path) -> None:
    sr = 8000
    data = np.zeros((int(sr * 130), 1), dtype=np.float32)
    data[::100] = 0.5
    p = tmp_path / "long.wav"
    sf.write(str(p), data, sr)
    with pytest.raises(AudioLoadError):
        load_wav(p, "take")


def test_audio_load_keeps_original_file(tmp_path) -> None:
    sr = 16000
    rng = np.random.default_rng(0)
    data = rng.standard_normal((sr * 3, 1)).astype(np.float32) * 0.1
    p = tmp_path / "a.wav"
    sf.write(str(p), data, sr)
    before = p.read_bytes()
    clip = load_wav(p, "reference")
    assert p.read_bytes() == before
    assert clip.duration == pytest.approx(3.0, abs=1e-3)


def test_mismatched_recordings_rejected(samples) -> None:
    """两份不同内容的录音不能被"对齐"出看似合理的曲线。"""

    from dualalign.samples import write_sample

    folder = samples["folder"]
    a = write_sample(SampleSpec(name="mismatch_a", ref_duration_s=10.0), folder)
    b = write_sample(SampleSpec(name="mismatch_b", ref_duration_s=10.0, seed=4242), folder)
    ref = load_wav(folder / a.files["reference"], "reference")
    take = load_wav(folder / b.files["take"], "take")
    with pytest.raises(AlignmentError):
        analyze(ref, take)


def test_different_sample_rates_supported(samples) -> None:
    m = samples["demo"]
    assert m.files["reference_sample_rate"] == 48_000
    assert m.files["take_sample_rate"] == 44_100


# ---------------------------------------------------------------------------
# 界面 (离屏): 只验证交互链路, 不验证像素
# ---------------------------------------------------------------------------


def test_gui_end_to_end(demo) -> None:
    from PySide6.QtWidgets import QApplication
    import PySide6.QtWidgets as widgets

    from dualalign.gui.main_window import MainWindow

    app = QApplication.instance() or QApplication([])
    sink = NullSink()
    engine = AudioEngine(sink)
    window = MainWindow(engine=engine)
    try:
        window.ref_clip = demo["ref"]
        window.take_clip = demo["take"]
        window.result = demo["result"]
        window.timeline.set_result(demo["result"])
        window._refresh_panels()
        engine.set_result(demo["result"])
        window.play_start.setValue(9.0)
        window.play_end.setValue(11.0)
        window.start_preview()
        assert sink.played
        window.invalidate_preview()
        assert engine.current is None
        # 锚点冲突必须弹窗提示, 并且结果不被修改
        messages: list[str] = []
        original_warning = widgets.QMessageBox.warning
        widgets.QMessageBox.warning = staticmethod(
            lambda *args, **kwargs: messages.append(args[2] if len(args) > 2 else "")
        )
        try:
            window.anchor_ref_spin.setValue(20.0)
            window.anchor_take_spin.setValue(1.0)
            window.apply_anchor()
        finally:
            widgets.QMessageBox.warning = original_warning
        assert messages and ("冲突" in messages[0] or "倒放" in messages[0])
        assert window.result.anchors == []
        # 合法锚点生效
        ref_t = 15.0
        take_t = float(demo["result"].curve.take_time_at(ref_t)) + 0.1
        window.anchor_ref_spin.setValue(ref_t)
        window.anchor_take_spin.setValue(take_t)
        window.apply_anchor()
        assert len(window.result.anchors) == 1
        assert window.anchor_list.count() >= 1
        # 重新分析 (新结果) 后旧试听失效
        old_clip = engine.play(10.0, 12.0)
        window._invalidate_result("测试")
        assert not engine.is_current(old_clip)
    finally:
        window.close()
        app.processEvents()


def test_gui_anchor_and_focus_flow(demo) -> None:
    """界面交互链路: 聚焦缺失区间、加锚点、切换试听内容。"""

    from PySide6.QtWidgets import QApplication

    from dualalign.gui.main_window import MainWindow

    app = QApplication.instance() or QApplication([])
    engine = AudioEngine(NullSink())
    window = MainWindow(engine=engine)
    try:
        window.ref_clip = demo["ref"]
        window.take_clip = demo["take"]
        result = demo["result"]
        window.result = result
        window.timeline.set_result(result)
        window.take_view.set_result(result)
        window._refresh_panels()
        engine.set_result(result)
        # 双击波形设置候选锚点 -> 用自动匹配填充 -> 应用
        ref_t = 15.0
        window.on_anchor_add_requested(ref_t)
        assert abs(window.anchor_ref_spin.value() - ref_t) < 1e-6
        window.fill_anchor_from_auto()
        window.anchor_take_spin.setValue(window.anchor_take_spin.value() + 0.1)
        window.apply_anchor()
        assert len(window.result.anchors) == 1
        # 聚焦缺失区间时指针应报出"处于缺失区间"
        missing_index = next(
            i for i in range(window.gap_list.count())
            if "缺失区间" in window.gap_list.item(i).text()
        )
        window.focus_gap(window.gap_list.item(missing_index))
        assert "处于缺失区间" in window.cursor_label.text()
        # 切换试听内容会立即让旧片段失效
        window.play_start.setValue(9.0)
        window.play_end.setValue(11.0)
        window.start_preview()
        window.play_mode.setCurrentIndex(2)  # 仅对齐结果
        assert engine.current is None
        window.start_preview()
        assert engine.current is not None and engine.current.mode == "aligned"
        window.stop_preview()
        assert engine.current is None
    finally:
        window.close()
        app.processEvents()


def test_gui_screenshot_paints(demo, tmp_path) -> None:
    """确保绘图代码在没有真实窗口时也能完整执行 (无异常)。"""

    from PySide6.QtWidgets import QApplication

    from dualalign.gui.main_window import MainWindow

    app = QApplication.instance() or QApplication([])
    window = MainWindow(engine=AudioEngine(NullSink()))
    try:
        window.resize(1280, 900)
        window.ref_clip = demo["ref"]
        window.take_clip = demo["take"]
        window.result = demo["result"]
        window.timeline.set_result(demo["result"])
        window.timeline.set_view(0.0, 10.0)
        window._refresh_panels()
        window.show()
        app.processEvents()
        pixmap = window.grab()
        assert not pixmap.isNull()
        out = tmp_path / "shot.png"
        pixmap.save(str(out))
        assert out.stat().st_size > 5000
    finally:
        window.close()
        app.processEvents()
