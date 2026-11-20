"""一键自动验证入口 (无需图形界面, 不需要外部模型/在线服务).

用法:
    python verify.py            # 生成素材 -> 跑关键断言 -> 打印报告, 退出码 0/1
    python verify.py --keep     # 保留生成的 wav 到 ./sample_data
    python verify.py --pytest   # 改为运行完整 pytest 套件

断言覆盖:
    * 已知起点偏移
    * 漂移末端误差 (相对未修正的累积漂移)
    * 缺失区间的位置、静音与有效声音区间
    * 冲突锚点被拒绝且不产生倒放/折返
    * 导出 wav 与参考等长, 再次打开与预览位置一致
    * 试听片段在切换/停止/重新分析后失效
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def _check(results: list, name: str, fn) -> None:
    try:
        detail = fn()
    except AssertionError as exc:
        results.append((False, name, f"断言失败: {exc}"))
        traceback.print_exc()
        return
    except Exception as exc:  # noqa: BLE001
        results.append((False, name, f"异常: {type(exc).__name__}: {exc}"))
        traceback.print_exc()
        return
    results.append((True, name, detail or ""))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="双录音对齐自动验证")
    parser.add_argument("--keep", action="store_true", help="保留生成的样例 wav 到 ./sample_data")
    parser.add_argument("--pytest", action="store_true", help="运行完整 pytest 套件")
    parser.add_argument("--out", default="", help="样例输出目录 (默认临时目录)")
    args = parser.parse_args(argv)

    if args.pytest:
        import pytest

        return pytest.main(["-q", str(ROOT / "tests")])

    from dualalign.align import Anchor, AnchorConflictError, analyze
    from dualalign.audio import load_wav
    from dualalign.engine import AudioEngine, NullSink, PlaybackError
    from dualalign.export import export_result, verify_export
    from dualalign.render import position_consistency
    from dualalign.samples import generate_all

    out_dir = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="dualalign_verify_"))
    print(f"生成内置素材 -> {out_dir}")
    manifests = generate_all(out_dir)
    demo = manifests["demo"]
    repeat = manifests["repeat_heavy"]
    ref = load_wav(out_dir / demo.files["reference"], "reference")
    take = load_wav(out_dir / demo.files["take"], "take")
    print(f"  参考 {ref.duration:.2f}s @ {ref.sample_rate}Hz, "
          f"待对齐 {take.duration:.2f}s @ {take.sample_rate}Hz")
    print("分析中…")
    result = analyze(ref, take)
    print(f"  对应点 {len(result.matches)}, 缺失区间 "
          f"{[(round(g.ref_start, 2), round(g.ref_end, 2)) for g in result.missing_gaps]}, "
          f"置信不足 {len(result.low_confidence)} 段")
    results: list[tuple[bool, str, str]] = []

    def known_offset():
        start = demo.expected_start_offset_s
        lead = [g for g in result.gaps if g.kind == "lead_in"]
        assert lead, "未识别出参考开头的无对应区间"
        assert abs(lead[0].ref_end - start) < 0.10, (lead[0].ref_end, start)
        pairs = [(r["ref_s"], r["take_s"]) for r in demo.mapping
                 if r["take_s"] is not None and r["ref_s"] >= start + 1.0 and r["take_s"] <= 5.0]
        errors = [abs(float(result.curve.take_time_at(r)) - t) for r, t in pairs]
        assert errors and max(errors) < 0.030, max(errors)
        return f"已知起点 {start:.2f}s, 检测 {lead[0].ref_end:.2f}s, 起点附近映射误差 ≤ {max(errors) * 1000:.1f}ms"

    def drift_end():
        uncorrected = abs(demo.expected_end_drift_s)
        assert uncorrected > 0.2, uncorrected
        pairs = [(r["ref_s"], r["take_s"]) for r in demo.mapping
                 if r["take_s"] is not None and r["ref_s"] >= demo.end_ref_s - 12.0]
        errors = [abs(float(result.curve.take_time_at(r)) - t) for r, t in pairs]
        assert errors and max(errors) < 0.030, max(errors)
        assert abs(result.trend.overall_drift_percent) > 0.3
        return (f"末端未修正漂移 {uncorrected * 1000:.0f}ms, 对齐后末端误差 ≤ "
                f"{max(errors) * 1000:.1f}ms, 报告漂移 {result.trend.overall_drift_percent:+.2f}%")

    def missing_region():
        (a, b), = demo.missing_ref_regions
        gaps = result.missing_gaps
        assert len(gaps) == 1, gaps
        g = gaps[0]
        assert abs(g.ref_start - a) < 0.20 and abs(g.ref_end - b) < 0.20, (g.ref_start, g.ref_end)
        mid_before = float(result.curve.take_time_at(g.ref_start + 0.05))
        mid_after = float(result.curve.take_time_at(g.ref_end - 0.05))
        assert abs(mid_after - mid_before) < 0.01, (mid_before, mid_after)
        return (f"缺失区间检测 {g.ref_start:.2f}-{g.ref_end:.2f}s (真实 {a:.2f}-{b:.2f}s), "
                f"区间内映射保持恒定, 不被拉伸")

    def missing_silence(tmp: Path):
        _, wav, _ = export_result(result, tmp / "aligned.wav")
        import soundfile as sf

        data, sr = sf.read(str(wav), dtype="float64", always_2d=True)
        g = result.missing_gaps[0]
        a, b = int(g.ref_start * sr) + 10, int(g.ref_end * sr) - 10
        peak = float(np.max(np.abs(data[a:b])))
        assert peak < 1e-5, peak
        assert result.coverage_regions, "缺少有效声音区间"
        return (f"缺失区间导出峰值 {peak:.2e} (静音), 有效声音区间 "
                f"{[(round(x, 2), round(y, 2)) for x, y in result.coverage_regions]}")

    def conflict():
        try:
            result.with_anchors([Anchor(10.0, 20.0), Anchor(20.0, 5.0)])
        except AnchorConflictError as exc:
            assert "倒放" in str(exc) or "折返" in str(exc) or "冲突" in str(exc)
        else:
            raise AssertionError("冲突锚点未被拒绝")
        g = result.missing_gaps[0]
        try:
            result.with_anchors([Anchor(0.5 * (g.ref_start + g.ref_end), 21.0)])
        except AnchorConflictError:
            pass
        else:
            raise AssertionError("缺失区间内的锚点未被拒绝")
        assert result.anchors == []
        assert np.all(np.diff(result.curve.knots_take) >= -1e-9)
        return "时间顺序冲突 / 落在缺失区间的锚点均被拒绝, 原结果未被破坏"

    def anchors_apply():
        base = float(result.curve.take_time_at(15.0))
        updated = result.with_anchors([Anchor(15.0, base + 0.2, "verify")])
        assert abs(float(updated.curve.take_time_at(15.0)) - (base + 0.2)) < 1e-3
        neighbour_shift = abs(float(updated.curve.take_time_at(16.0))
                              - float(result.curve.take_time_at(16.0)))
        assert neighbour_shift > 0.02, neighbour_shift
        assert np.all(np.diff(updated.curve.knots_take) >= -1e-9)
        return f"锚点精确命中, 相邻 1s 处移动 {neighbour_shift * 1000:.0f}ms, 映射保持单调"

    def export_roundtrip(tmp: Path):
        anchor = Anchor(15.0, float(result.curve.take_time_at(15.0)) + 0.15, "verify")
        updated = result.with_anchors([anchor])
        summary, wav, desc = export_result(updated, tmp / "aligned_anchor.wav")
        import soundfile as sf

        info = sf.info(str(wav))
        assert info.frames == ref.frames and info.samplerate == ref.sample_rate
        report = position_consistency(updated, wav, tolerance_ms=2.0)
        assert report["ok"], report
        verification = verify_export(desc)
        assert verification["ok"], verification["checks"]
        return (f"导出 {info.frames} 帧与参考等长, 再次打开与预览最大偏差 "
                f"{report['max_abs_lag_ms']:.2f}ms, 锚点写入说明")

    def playback_invalidation():
        sink = NullSink()
        engine = AudioEngine(sink)
        engine.set_result(result)
        clip = engine.play(9.0, 11.0)
        assert engine.is_current(clip)
        engine.play(15.0, 17.0)
        assert not engine.is_current(clip)
        try:
            engine.play_with(clip)
        except PlaybackError:
            pass
        else:
            raise AssertionError("旧试听片段仍然可播放")
        engine.stop()
        assert engine.current is None
        clip3 = engine.play(5.0, 7.0)
        engine.set_result(result)
        assert not engine.is_current(clip3)
        return "切换区间/停止/重新分析后, 上一次试听片段均失效"

    def repeat_case():
        ref2 = load_wav(out_dir / repeat.files["reference"], "reference")
        take2 = load_wav(out_dir / repeat.files["take"], "take")
        res2 = analyze(ref2, take2)
        assert res2.low_confidence, "重复节奏素材未给出置信不足提示"
        rep0, rep1 = repeat.spec["repeated_region_s"]
        covered = [r for r in res2.low_confidence if r.ref_start < rep1 and r.ref_end > rep0]
        assert covered, [r.as_dict() for r in res2.low_confidence]
        return f"重复节奏素材给出 {len(res2.low_confidence)} 段置信不足提示"

    tmp = out_dir / "export_check"
    tmp.mkdir(exist_ok=True)
    _check(results, "已知起点偏移", known_offset)
    _check(results, "漂移末端误差", drift_end)
    _check(results, "中间缺失区间检测", missing_region)
    _check(results, "缺失区间导出静音 + 有效区间", lambda: missing_silence(tmp))
    _check(results, "冲突锚点提示", conflict)
    _check(results, "人工锚点更新相邻关系", anchors_apply)
    _check(results, "导出再次打开位置一致", lambda: export_roundtrip(tmp))
    _check(results, "试听失效", playback_invalidation)
    _check(results, "低置信区间提示", repeat_case)

    print()
    ok = True
    for passed, name, detail in results:
        mark = "PASS" if passed else "FAIL"
        print(f"[{mark}] {name}\n        {detail}")
        ok = ok and passed
    print()
    if not ok:
        failed = sum(1 for p, _, _ in results if not p)
        print(f"{failed} 项未通过")
        return 1
    print(f"全部 {len(results)} 项通过")
    if args.keep:
        target = ROOT / "sample_data"
        target.mkdir(exist_ok=True)
        for path in out_dir.glob("demo_*"):
            shutil.copy2(path, target / path.name)
        for path in out_dir.glob("repeat_heavy_*"):
            shutil.copy2(path, target / path.name)
        print(f"素材已保存到 {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
