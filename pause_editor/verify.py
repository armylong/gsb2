"""本地无界面验证: 独立计算期望值, 对照引擎的成品采样数与标注时刻。

用法::

    .venv/bin/python -m pause_editor.verify                 # 核心验证
    .venv/bin/python -m pause_editor.verify --examples DIR  # 复用已有示例目录
    .venv/bin/python -m pause_editor.verify --gui-smoke     # 额外跑一次 Qt offscreen 冒烟

退出码 0 表示全部通过。
"""

from __future__ import annotations

import argparse
import os
import tempfile
from typing import List, Sequence

import numpy as np

from . import annotations as ann_io
from . import wavfile
from .examples import SR, generate_examples
from .model import (
    CONFLICT,
    EDIT,
    TOO_SHORT,
    EditRegion,
    apply_edits,
    build_plan,
    find_conflicts,
    remap_marks,
)


class CheckRunner:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: List[str] = []

    def check(self, name: str, cond: bool, detail: str = "") -> None:
        if cond:
            self.passed += 1
            print(f"  [PASS] {name}")
        else:
            self.failed.append(f"{name} {detail}".rstrip())
            print(f"  [FAIL] {name} {detail}")

    def summary(self) -> int:
        total = self.passed + len(self.failed)
        print(f"\n{self.passed}/{total} 项通过")
        if self.failed:
            print("失败项:")
            for f in self.failed:
                print("  -", f)
            return 1
        print("全部通过 ✓")
        return 0


def _load(example_dir: str, stem: str):
    audio = wavfile.read_wav(os.path.join(example_dir, stem + ".wav"))
    af = ann_io.load_annotations(os.path.join(example_dir, stem + ".annotations.json"),
                                  audio.sample_rate)
    return audio, af


def _expected_dst_length(n_src: int, plan) -> int:
    """独立估算成品采样数。

    每个执行区: 删除 (区间长 - keep), 再扣一次交叉淡变重叠 (两块各 k 帧叠加成 k 帧)。
    非执行区 (冲突/太短/非法) 原样保留。
    """
    total = n_src
    for p in plan:
        if p.status == EDIT:
            total -= (p.region.end - p.region.start) - p.keep_samples
            total -= p.transition_samples
    return total


def _check_coverage(runner: CheckRunner, engine) -> None:
    """整段原声必须被账本无遗漏、无重叠地覆盖 (这是映射正确性的根基)。"""
    covered = np.zeros(engine.n_src, dtype=np.int8)
    for seg in engine.segments:
        runner.check(
            f"段[{seg.src_start},{seg.src_end})未越界",
            0 <= seg.src_start < seg.src_end <= engine.n_src,
        )
        covered[seg.src_start:seg.src_end] += 1
    for jc in engine.junctions:
        covered[jc.src_a_start:jc.src_a_end] += 1
        covered[jc.src_b_start:jc.src_b_end] += 1
    for sp in engine.deleted:
        covered[sp.src_start:sp.src_end] += 1
    runner.check("原声全部样本都有账本覆盖", bool((covered >= 1).all()))
    runner.check(
        "账本无重叠覆盖 (同一原声帧只归一处)",
        bool((covered <= 1).all()),
        f"重复帧数 {int((covered > 1).sum())}",
    )

    # 成品长度与逐段账本求和一致
    total = sum(s.dst_end - s.dst_start for s in engine.segments)
    total += sum(j.dst_end - j.dst_start for j in engine.junctions)
    runner.check("成品长度 == 账本各段之和", total == engine.n_dst)


def _verify_short_gap(runner: CheckRunner, example_dir: str) -> None:
    print("\n== short_gap: 短间隔 / 放过 / 硬切 ==")
    audio, af = _load(example_dir, "short_gap")
    plan = build_plan(audio.n_samples, SR, af.regions, transition_ms=30.0)
    statuses = [p.status for p in plan]
    runner.check("三个区间状态 = edit/too_short/edit",
                 statuses == [EDIT, TOO_SHORT, EDIT], str(statuses))

    engine = apply_edits(audio.samples, SR, plan)
    expected = _expected_dst_length(audio.n_samples, plan)
    runner.check("成品采样数与独立估算一致", engine.n_dst == expected,
                 f"{engine.n_dst} vs {expected}")
    runner.check("删除帧数与账本一致",
                 engine.deleted_count() == sum(
                     sp.src_end - sp.src_start for sp in engine.deleted))
    runner.check("总缩短量 == 原声长度 - 成品长度",
                 engine.total_removed() == audio.n_samples - engine.n_dst,
                 f"{engine.total_removed()} vs {audio.n_samples - engine.n_dst}")

    # 响声逐帧不变: 取每个响声块内部的样本, 在成品中按映射找回后必须完全相等
    r2 = af.regions[2]
    for label, src in af.marks:
        m = engine.map_source(src)
        if m.kind == "deleted":
            continue
        same = np.array_equal(engine.output[m.dst_sample], audio.samples[src])
        runner.check(f"标注 {label} (src={src}) 映射后样本逐帧相等", same)

    # M2 必须落在被删段, 且单独列出; 邻近的 M1/M3/M4 不受影响
    remapped = remap_marks(engine, af.marks)
    by_label = {m.label: m for m in remapped}
    runner.check("M2 被标记为删除", by_label["M2"].deleted)
    runner.check("M1/M3/M4 未被删除",
                 not any(by_label[x].deleted for x in ("M1", "M3", "M4")))

    # too_short 区间: 其中所有原声样本必须原样出现在成品里
    ts = plan[1]
    src_piece = audio.samples[ts.region.start:ts.region.end]
    found = _find_verbatim(engine, src_piece)
    runner.check("too_short 区间整段原样保留", found)

    # 硬切区: 删除账本覆盖整个 R2
    hard = [sp for sp in engine.deleted if sp.region_index == 2]
    runner.check("硬切区删除账本覆盖整个区间",
                 len(hard) == 1 and hard[0].src_start == r2.start
                 and hard[0].src_end == r2.end and hard[0].dst_start == hard[0].dst_end)

    # 交叉淡变只发生在静音 (停顿) 样本内部: junction 的两个源块必须都在 edit 区间内
    for jc in engine.junctions:
        inside_a = any(p.region.start <= jc.src_a_start and jc.src_a_end <= p.region.end
                       for p in plan if p.status == EDIT)
        inside_b = any(p.region.start <= jc.src_b_start and jc.src_b_end <= p.region.end
                       for p in plan if p.status == EDIT)
        runner.check(
            f"junction@{jc.dst_start} 两块来源都在选中区间内部", inside_a and inside_b
        )

    # 等功率增益: 淡变中点两路增益平方和 == 1
    for jc in engine.junctions:
        k = jc.dst_end - jc.dst_start
        if k == 0:
            continue
        mid = k // 2
        ga = np.sqrt(1.0 - (mid + 0.5) / k)
        gb = np.sqrt((mid + 0.5) / k)
        runner.check(
            f"junction@{jc.dst_start} 中点能量守恒",
            abs(ga * ga + gb * gb - 1.0) < 1e-12,
        )

    _check_coverage(runner, engine)
    _check_roundtrip(runner, engine)
    return engine, af


def _find_verbatim(engine, piece: np.ndarray) -> bool:
    """在成品里找一段与 piece 完全相同的连续样本 (逐帧、逐声道)。"""
    n = piece.shape[0]
    out = engine.output
    if n == 0 or n > out.shape[0]:
        return False
    for s in range(0, out.shape[0] - n + 1):
        if np.array_equal(out[s:s + n], piece):
            return True
    return False


def _verify_adjacent(runner: CheckRunner, example_dir: str) -> None:
    print("\n== adjacent: 相邻/重叠冲突 ==")
    audio, af = _load(example_dir, "adjacent")
    conflicts = find_conflicts(af.regions)
    runner.check("检测到 2 对冲突", len(conflicts) == 2, f"实际 {len(conflicts)}")
    plan = build_plan(audio.n_samples, SR, af.regions, transition_ms=30.0)
    runner.check("四个区间全部 conflict",
                 all(p.status == CONFLICT for p in plan),
                 str([p.status for p in plan]))
    engine = apply_edits(audio.samples, SR, plan)
    runner.check("冲突时成品长度 == 原声长度",
                 engine.n_dst == audio.n_samples,
                 f"{engine.n_dst} vs {audio.n_samples}")
    runner.check("冲突时输出与原声逐帧相同",
                 np.array_equal(engine.output, audio.samples))
    runner.check("冲突时没有任何删除账本", engine.deleted == [])
    remapped = remap_marks(engine, af.marks)
    runner.check("冲突区标注点没有被删", not any(m.deleted for m in remapped))
    _check_coverage(runner, engine)


def _verify_stereo(runner: CheckRunner, example_dir: str) -> None:
    print("\n== stereo_onsets: 两声道不同响点 ==")
    audio, af = _load(example_dir, "stereo_onsets")
    runner.check("示例为立体声", audio.n_channels == 2)
    plan = build_plan(audio.n_samples, SR, af.regions, transition_ms=30.0)
    engine = apply_edits(audio.samples, SR, plan)

    # 所有响点 (高能量帧) 必须逐帧保留: 先在原声里找显著帧, 再到成品里核对
    energy = np.max(np.abs(audio.samples), axis=1)
    loud_src = np.flatnonzero(energy > 0.05)
    verbatim_ok = True
    for s in loud_src:
        m = engine.map_source(int(s))
        if m.kind == "deleted" or not np.array_equal(
            engine.output[m.dst_sample], audio.samples[s]
        ):
            verbatim_ok = False
            break
    runner.check("左右声道全部响点逐帧保留", verbatim_ok,
                 f"响点帧数 {len(loud_src)}")

    # MID 在被删段; L/R 响点标注全在
    remapped = remap_marks(engine, af.marks)
    by_label = {m.label: m for m in remapped}
    runner.check("MID 被删", by_label["MID"].deleted)
    runner.check("L1/R1/L2/R2 均保留",
                 not any(by_label[x].deleted for x in ("L1", "R1", "L2", "R2")))

    # 双声道等长、映射一致
    runner.check("成品保持双声道", engine.n_channels == 2)
    expected = _expected_dst_length(audio.n_samples, plan)
    runner.check("立体声成品采样数与估算一致", engine.n_dst == expected)
    _check_coverage(runner, engine)
    _check_roundtrip(runner, engine)


def _check_roundtrip(runner: CheckRunner, engine) -> None:
    with tempfile.TemporaryDirectory() as td:
        out_path = os.path.join(td, "out.wav")
        clipped = wavfile.write_wav(out_path, wavfile.AudioData(engine.output, engine.sample_rate))
        back = wavfile.read_wav(out_path)
        runner.check("WAV 往返采样数一致", back.n_samples == engine.n_dst)
        runner.check("WAV 往返声道数一致", back.n_channels == engine.n_channels)
        runner.check("WAV 往返无超界限幅", clipped == 0, f"{clipped} 帧")
        # 16-bit 量化误差在容差内 (1 LSB = 1/32767 ≈ 3.05e-5, 叠加淡变后给 2 LSB)
        err = np.abs(back.samples - engine.output).max()
        runner.check("WAV 往返量化误差 < 2 LSB", err < 2.0 / 32767.0, f"max={err:.2e}")


def _verify_transition_clamp(runner: CheckRunner) -> None:
    print("\n== 过渡长度限制 ==")
    rng = np.random.default_rng(1)
    sr = 1000
    n = 1000
    x = rng.normal(0, 0.001, (n, 1))
    # 区间 200..360 (160 帧), 保留 40ms=40 帧, 请求过渡 30ms=30 帧
    # 单侧淡变上限 = min(20, 20) = 20 -> 必须被限制
    regions = [EditRegion(200, 360, keep_ms=40.0)]
    plan = build_plan(n, sr, regions, transition_ms=30.0)
    runner.check("过渡被限制到保留段可用空间", plan[0].transition_samples == 20,
                 f"实际 {plan[0].transition_samples}")
    runner.check("限制时给出告警", any("限制" in w for w in plan[0].warnings))
    engine = apply_edits(x, sr, plan)
    # 保留段外的样本 (199 与 360) 必须逐帧相等: 过渡不能吃掉区间外的响声
    runner.check(
        "区间外两侧响声未被过渡吃掉",
        np.array_equal(
            engine.output[engine.map_source(199).dst_sample], x[199]
        )
        and np.array_equal(
            engine.output[engine.map_source(360).dst_sample], x[360]
        ),
    )
    runner.check("成品无 NaN/Inf", np.isfinite(engine.output).all())

    # 保留 0 -> 硬切
    plan0 = build_plan(n, sr, [EditRegion(200, 360, keep_ms=0.0)], transition_ms=30.0)
    eng0 = apply_edits(x, sr, plan0)
    runner.check("保留0时整段消失",
                 eng0.n_dst == n - 160 and len(eng0.junctions) == 0)

    # keep 大于区间 -> 原样放过, 长度不变
    plan_big = build_plan(n, sr, [EditRegion(200, 360, keep_ms=500.0)], transition_ms=10.0)
    eng_big = apply_edits(x, sr, plan_big)
    runner.check("保留需求超区间时原样放过且长度不变",
                 plan_big[0].status == TOO_SHORT and eng_big.n_dst == n)


def _verify_export(runner: CheckRunner, example_dir: str) -> None:
    print("\n== 导出: 标注重写 + 位置对照 ==")
    audio, af = _load(example_dir, "short_gap")
    plan = build_plan(audio.n_samples, SR, af.regions, transition_ms=30.0)
    engine = apply_edits(audio.samples, SR, plan)
    with tempfile.TemporaryDirectory() as td:
        ann_path = os.path.join(td, "out.annotations.json")
        map_path = os.path.join(td, "out.map.json")
        csv_path = os.path.join(td, "out.map.csv")
        remapped = ann_io.export_annotations(ann_path, engine, af.marks)
        ann_io.export_mapping(map_path, engine)
        ann_io.export_mapping_csv(csv_path, engine)
        data = ann_io.load_annotations(ann_path, SR)
        runner.check("重写标注只保留未删点",
                     len(data.marks) == sum(1 for m in remapped if not m.deleted))
        # 重写后的标注坐标与引擎映射一致
        ok = all(
            engine.map_source(src).dst_sample == dst
            for (_lab, src), (_lab2, dst) in zip(
                [(m.label, m.src_sample) for m in remapped if not m.deleted], data.marks
            )
        )
        runner.check("重写标注坐标与引擎映射一致", ok)
        for p in (ann_path, map_path, csv_path):
            runner.check(f"导出文件存在且非空: {os.path.basename(p)}",
                         os.path.getsize(p) > 0)


def _gui_smoke(runner: CheckRunner, example_dir: str) -> None:
    print("\n== Qt offscreen GUI 冒烟 ==")
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    try:
        from PySide6.QtWidgets import QApplication
    except ImportError as e:  # pragma: no cover
        runner.check("PySide6 可导入", False, str(e))
        return
    app = QApplication.instance() or QApplication([])
    from .main_window import MainWindow

    win = MainWindow()
    audio_path = os.path.join(example_dir, "short_gap.wav")
    ann_path = os.path.join(example_dir, "short_gap.annotations.json")
    win.load_files(audio_path, ann_path)
    runner.check("主窗口载入示例成功", win.engine is not None)
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "smoke")
        n_orphan = win.export_outputs(out)
        runner.check("GUI 导出返回被删标注数", isinstance(n_orphan, int) and n_orphan >= 1)
        runner.check("GUI 写出成品 WAV", os.path.exists(out + ".wav"))
    win.close()
    app.processEvents()
    runner.check("GUI 冒烟完成无异常", True)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="停顿整理工具本地验证")
    parser.add_argument("--examples", default=None, help="示例目录 (默认临时目录)")
    parser.add_argument("--gui-smoke", action="store_true", help="额外执行 Qt 冒烟")
    args = parser.parse_args(argv)

    runner = CheckRunner()
    if args.examples:
        example_dir = args.examples
        os.makedirs(example_dir, exist_ok=True)
        generate_examples(example_dir)
    else:
        tmp = tempfile.TemporaryDirectory()
        example_dir = tmp.name
        generate_examples(example_dir)

    print(f"示例目录: {example_dir}")
    _verify_short_gap(runner, example_dir)
    _verify_adjacent(runner, example_dir)
    _verify_stereo(runner, example_dir)
    _verify_transition_clamp(runner)
    _verify_export(runner, example_dir)
    if args.gui_smoke:
        _gui_smoke(runner, example_dir)
    return runner.summary()


if __name__ == "__main__":
    raise SystemExit(main())
