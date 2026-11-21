"""一条命令完成的验证: 合成对照 + 模型编辑语义 + 无损区间导出检查.

    python -m spikefix.verify

退出码 0 表示全部通过.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from .benchmark import make_clean_percussion, make_degraded, hit_active_windows, run_benchmark
from .dsp import merge_spans, repair_channel, detect
from .model import Project
from .wavio import load_wav


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes = 0

    def check(self, cond: bool, name: str, detail: str = "") -> None:
        if cond:
            self.passes += 1
            print(f"  ✓ {name}")
        else:
            self.failures.append(f"{name}" + (f" — {detail}" if detail else ""))
            print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))

    def section(self, title: str) -> None:
        print(f"\n[{title}]")


def check_detector(c: Checker) -> None:
    c.section("检测: 干净真实打击音不应产生可自动修复标记")
    total_spikes = 0
    for seed in range(1, 9):
        clean, _ = make_clean_percussion(seed=seed)
        res = detect(clean.samples)
        total_spikes += len(res.spikes)
    c.check(total_spikes == 0, "8 个随机种子下干净原声自动修复标记为 0",
            f"实际 {total_spikes}")

    c.section("检测: 注入的孤立脉冲应被找出")
    matched = 0
    total = 0
    for seed in range(1, 9):
        clean, hits = make_clean_percussion(seed=seed)
        deg, inj = make_degraded(clean, hits, seed=seed + 4)
        dets = detect(deg.samples).detections()
        for i in inj:
            if i.note:
                continue
            total += 1
            if any(d.channel == i.channel and d.start - 2 <= i.end and d.end + 2 >= i.start
                   for d in dets):
                matched += 1
    c.check(matched == total, "安静区注入脉冲全部被标记", f"{matched}/{total}")

    c.section("保护: 真实敲击区间内不应被自动修复")
    bad = 0
    for seed in range(1, 9):
        clean, hits = make_clean_percussion(seed=seed)
        deg, inj = make_degraded(clean, hits, seed=seed + 4)
        windows = hit_active_windows(hits)
        for d in detect(deg.samples).spikes:
            if any(a - 1 <= d.start <= b + 1 for a, b in windows):
                bad += 1
    c.check(bad == 0, "自动修复区间不落入真实敲击活动窗", f"落入 {bad} 个")


def check_repair(c: Checker) -> None:
    c.section("修复: 区间外采样逐位不变")
    rng = np.random.default_rng(0)
    x = rng.standard_normal(2000) * 0.1
    x[500] += 0.8
    x[1200:1202] += 0.6
    y = repair_channel(x, [(500, 500), (1200, 1201)], "linear")
    outside = np.ones(x.shape[0], dtype=bool)
    outside[[500, 1200, 1201]] = False
    c.check(np.array_equal(x[outside], y[outside]), "linear: 区间外逐位一致")
    y2 = repair_channel(x, [(500, 500), (1200, 1201)], "cubic")
    c.check(np.array_equal(x[outside], y2[outside]), "cubic: 区间外逐位一致")
    c.check(abs(y[500]) < abs(x[500]), "跳点幅度被压低")

    c.section("修复: 重叠区间必须被拒绝")
    try:
        repair_channel(x, [(100, 110), (105, 120)], "linear")
        c.check(False, "重叠区间抛出异常")
    except ValueError:
        c.check(True, "重叠区间抛出异常")

    merged, _ = merge_spans([(10, 12), (11, 15), (40, 41)], gap=0)
    c.check(merged == [(10, 15), (40, 41)], "merge_spans 合并重叠", str(merged))


def check_project(c: Checker) -> None:
    c.section("模型: 逐段接受/拒绝、两声道独立、重叠合并")
    clean, hits = make_clean_percussion(seed=7)
    deg, inj = make_degraded(clean, hits, seed=11)
    proj = Project()
    proj.load(deg)
    stats = proj.run_detection()
    c.check(stats["spike"] > 0, "检测到可修复候选", str(stats))
    spikes = proj.spikes
    chans = {s.channel for s in spikes}
    c.check(chans <= {0, 1}, "候选声道合法")
    # 接受一个, 拒绝一个
    proj.accept(spikes[0].id)
    proj.reject(spikes[1].id)
    c.check(proj.candidate(spikes[0].id).state == "accepted", "接受状态生效")
    c.check(proj.candidate(spikes[1].id).state == "rejected", "拒绝状态生效")
    spans = proj.applied_spans()
    c.check(any(len(v) > 0 for v in spans.values()), "接受后存在实际修复区间")

    # 两声道独立: 只接受 CH0 不影响 CH1
    proj2 = Project()
    proj2.load(deg)
    proj2.run_detection()
    ch0 = [s for s in proj2.spikes if s.channel == 0]
    ch1 = [s for s in proj2.spikes if s.channel == 1]
    if ch0 and ch1:
        a0, a1 = ch0[0], ch1[0]
        proj2.accept(a0.id)
        ch1_samples_before = proj2.original.samples[:, 1].copy()
        repaired = proj2.repaired_samples(include_preview=False)
        c.check(np.array_equal(repaired[:, 1], ch1_samples_before),
                "仅接受 CH1 候选时 CH2 完全不变")
        proj2.accept(a1.id)
        c.check(any(s for s in proj2.applied_spans().get(1, [])), "CH2 接受后独立生效")
    else:
        c.check(False, "两声道样例应各有候选")

    # 重叠范围调整应合并, 且不重复应用
    proj3 = Project()
    proj3.load(deg)
    proj3.params.merge_gap = 0
    proj3.run_detection()
    same_ch = [s for s in proj3.spikes]
    if len(same_ch) >= 2:
        a = same_ch[0]
        b = next((s for s in same_ch if s.channel == a.channel and s.id != a.id
                  and s.start > a.end + 1), None)
        if b is not None:
            before = len(proj3.candidates)
            in_span = [c for c in proj3.sorted_candidates(a.channel)
                       if c.id != a.id and not (c.end < a.start or c.start > b.end)]
            removed = proj3.set_range(a.id, a.start, b.end)
            c.check(b.id in removed, "重叠范围调整触发了合并提示")
            c.check(len(proj3.candidates) == before - len(in_span),
                    "被新范围覆盖的候选全部合并 (候选数相应减少)",
                    f"{before} -> {len(proj3.candidates)}, 预期减少 {len(in_span)}")
            merged = proj3.candidate(a.id)
            c.check(merged is not None and merged.start == a.start and merged.end == b.end,
                    "合并后的区间覆盖新范围")
            spans_ch = proj3.applied_spans().get(a.channel, [])
            for (s1, e1), (s2, e2) in zip(spans_ch, spans_ch[1:]):
                c.check(s2 > e1 + 1, "已接受区间互不重叠/相邻")
    # 画区间重叠时 repair 不会重复应用
    x = np.zeros(100)
    x[50] = 1.0
    y1 = repair_channel(x, merge_spans([(50, 50), (50, 50)], gap=0)[0])
    c.check(np.count_nonzero(y1 != x) <= 1, "重复区间合并不重复应用")

    c.section("模型: 未修改区间导出逐位一致")
    proj4 = Project()
    proj4.load(deg)
    proj4.run_detection()
    for s in proj4.spikes:
        proj4.accept(s.id)
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.wav"
        info = proj4.export(str(out))
        c.check(info["outside_changed"] == 0, "导出文件区间外采样与原始逐位一致",
                f"改动 {info['outside_changed']}")
        c.check(info["shape_ok"], "导出文件帧/声道数一致")
        back = load_wav(out)
        c.check(back.frames == deg.frames and back.channels == deg.channels,
                "回读 WAV 尺寸正确")
        spans = proj4.applied_spans()
        mask = np.zeros(deg.frames, dtype=bool)
        for ch_spans in spans.values():
            for a, b in ch_spans:
                mask[a:b + 1] = True
        c.check(np.array_equal(back.samples[~mask], proj4.original.samples[~mask]),
                "回读后区间外数据一致")
        # 试听截取: 同一帧区间的原声与修复必须等长同起点
        a, b = 1000, 2000
        o = proj4.region_playback(a, b, use_repaired=False)
        r = proj4.region_playback(a, b, use_repaired=True)
        c.check(o.frames == r.frames == b - a, "A/B 试听两段长度一致")
        c.check(o.frames == 1000, "A/B 试听帧数与选区一致")


def check_benchmark(c: Checker) -> None:
    c.section("合成对照: 指标达标")
    report, wavs = run_benchmark()
    scenarios = {s.name: s for s in report.scenarios}
    clean = scenarios["真实打击音(干净)"]
    injected = scenarios["原声+注入脉冲"]
    c.check(clean.detected_spike == 0, "干净原声误标为 0", str(clean.detected_spike))
    c.check(injected.false_marks == 0, "注入场景误标为 0", str(injected.false_marks))
    c.check(injected.matched >= 6, "注入脉冲命中 >= 6", str(injected.matched))
    c.check(injected.outside_changed_samples == 0, "修复区间外改动为 0")
    c.check(injected.repair_region_rms_db < -40.0,
            "修复区 RMS 误差 < -40 dBFS", f"{injected.repair_region_rms_db:.1f}")
    c.check(injected.hit_region_changed_samples == 0,
            "真实敲击区间未被改动", str(injected.hit_region_changed_samples))
    # 导出对照
    with tempfile.TemporaryDirectory() as td:
        from .benchmark import write_benchmark_wavs
        paths = write_benchmark_wavs(td)
        for key in ("clean", "degraded", "repaired"):
            c.check(Path(paths[key]).exists(), f"对照 wav 已写出: {key}")


def check_gui_smoke(c: Checker) -> None:
    """无界面环境下构建主窗口并走一遍 载入→检测→接受→A/B→导出."""
    c.section("界面: 无界面冒烟 (offscreen)")
    import os
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    try:
        from PySide6.QtWidgets import QApplication
        from .gui.main_window import MainWindow
    except Exception as exc:  # pragma: no cover
        c.check(False, "PySide6 可用", str(exc))
        return
    app = QApplication.instance() or QApplication([])
    _ = app  # 保持应用对象存活
    win = MainWindow()
    win.show()
    win.load_simple_sample()
    c.check(win.project.loaded and win.project.frames > 0, "界面载入程序内样例")
    c.check(len(win.project.spikes) > 0, "界面检测到可修复候选",
            str(len(win.project.spikes)))
    if not win.project.spikes:
        win.close()
        return
    cand = win.project.spikes[0]
    win.select_candidate(cand.id)
    c.check(win.selected_id == cand.id, "界面可选中候选")
    win._set_state(cand.id, "accepted")
    c.check(win.project.candidate(cand.id).state == "accepted", "界面接受候选生效")
    c.check(win.lbl_verify.text().find("修复区间之外改动: 0") >= 0,
            "界面校验显示区间外 0 改动")
    win.set_loop_from_candidate()
    loop = getattr(win, "_loop_range", None)
    c.check(loop is not None and loop[1] > loop[0], "界面设置局部循环区间", str(loop))
    if loop:
        o = win.project.region_playback(loop[0], loop[1], use_repaired=False)
        r = win.project.region_playback(loop[0], loop[1], use_repaired=True)
        c.check(o.frames == r.frames == loop[1] - loop[0],
                "A/B 试听原始与修复区间长度/起点一致")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "gui_out.wav"
        info = win.project.export(str(out))
        c.check(info["outside_changed"] == 0, "界面工作流的导出区外一致",
                str(info["outside_changed"]))
    win.close()


def main(argv: list[str] | None = None) -> int:
    checker = Checker()
    check_detector(checker)
    check_repair(checker)
    check_project(checker)
    check_benchmark(checker)
    check_gui_smoke(checker)
    print()
    if checker.failures:
        print(f"失败 {len(checker.failures)} 项 / 通过 {checker.passes} 项:")
        for f in checker.failures:
            print(f"  - {f}")
        return 1
    print(f"全部通过 ({checker.passes} 项检查).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
