"""少量可运行检查: 映射规则单测 + 样例端到端核对。

运行(仓库根目录):
    .venv/bin/python -m tests.checks

不依赖 pytest, 纯断言; 端到端部分会真实调用 ffmpeg 生成/转码/重解码。
"""
from __future__ import annotations

import math
import os
import shutil
import tempfile
import time

from fps_checker import TARGET_FPS_CHOICES
from fps_checker import exporter, mapping, probe, samples, verify


def _check_mapping_uniform() -> None:
    """CFR 源(25fps, 6s)在各目标帧率下的规则正确性。"""
    fps_src = 25
    n = 150
    ts = [i / fps_src for i in range(n)]
    for fps in TARGET_FPS_CHOICES:
        m = mapping.build_mapping(ts, ts, fps)
        assert m.output_count == math.floor(ts[-1] * fps) + 1
        assert m.frames[0].source_index == 0
        assert m.frames[0].out_time == 0.0
        # 输出时间严格栅格且递增
        for k, f in enumerate(m.frames):
            assert abs(f.out_time - k / fps) < 1e-12
            assert f.source_time <= f.out_time + 1e-9
            if f.gap_after is not None:
                assert f.out_time < f.source_time + 1e9 or f.gap_after >= -1e-9
        # floor 规则手工抽查
        for k in (0, 1, 7, 33, 100, m.output_count - 1):
            expect = mapping.select_source(ts, k / fps)
            assert m.frames[k].source_index == expect
        # 末帧不超出源范围, 时长差小于一个输出帧
        assert m.output_span <= ts[-1] + 1e-12
        assert 0 <= m.duration_diff < 1.0 / fps + 1e-12
        # 60fps 上变换必须出现重复帧; 30->24 下变换必须出现丢弃
        if fps == 60:
            assert m.repeat_count > 0
    m24 = mapping.build_mapping(ts, ts, 24)
    assert len(m24.unused_indices) > 0
    print("[OK] 均匀时间轴映射规则(4 个目标帧率, 含重复/丢弃/首尾)")


def _check_mapping_vfr() -> None:
    """VFR 双速率时间轴(50fps/25fps 交替)的选取与请求落空处理。"""
    schedule = samples.vfr_schedule()
    ts = [t for t, _d in schedule]
    durs = [d for _t, d in schedule]
    assert len(ts) == 200
    assert abs(ts[-1] + durs[-1] - 6.00) < 1e-9
    m = mapping.build_mapping(ts, ts, 30)
    # 请求落在两帧之间: gap_before 与 gap_after 都为正, 选的是前一帧
    between = [f for f in m.frames
               if f.gap_before > 1e-6 and f.gap_after is not None
               and f.gap_after > 1e-6]
    assert between, "VFR 转换中应当存在请求落在两帧之间的输出帧"
    f0 = between[0]
    assert f0.source_time <= f0.request_time < ts[f0.source_index + 1]
    # 绝不把请求时间回填成帧时间
    assert f0.source_time != f0.request_time
    # 请求恰好落在源帧上: 从真实落在 30fps 栅格的源帧时间里挑一个,
    # 必须精确命中该源帧而非相邻帧
    aligned = [t for t in ts if abs(t * 30 - round(t * 30)) < 1e-9 and t > 0]
    assert aligned, "VFR 调度中应存在落在输出栅格上的源帧时间"
    probe_t = aligned[0]
    hit = next(f for f in m.frames if abs(f.request_time - probe_t) < 1e-9)
    assert abs(ts[hit.source_index] - probe_t) < 1e-9
    # 使用次数统计自洽
    assert sum(m.source_usage.values()) == m.output_count
    assert sorted(m.used_indices) == [
        i for i in range(m.source_count) if i not in m.unused_indices
    ]
    print("[OK] VFR 时间轴映射(中间请求真实选择、整点命中、统计自洽)")


def _check_end_to_end() -> None:
    work = tempfile.mkdtemp(prefix="fpsc_checks_")
    out_dir = os.path.join(work, "out")
    try:
        t0 = time.time()
        paths = samples.generate_all(work, out_dir)
        print(f"[OK] 生成样例 CFR/VFR ({time.time() - t0:.1f}s)")

        for tag, path, expect_vfr in (
            ("CFR", paths["cfr"], False),
            ("VFR", paths["vfr"], True),
        ):
            src = probe.load_video(path, os.path.join(work, f"load_{tag}"))
            assert src.is_vfr is expect_vfr
            gaps = [g for g in src.intervals if g is not None]
            if expect_vfr:
                assert max(gaps) / min(gaps) > 1.5  # 长短帧差异(0.04 vs 0.02)
                assert src.frame_count == 200      # 段数/帧数与调度一致
                # 24/25/30fps 下变换必须出现真实丢帧, 60fps 上变换以重复为主
                for low_fps in (24, 25, 30):
                    low = mapping.build_mapping(src.zero_ts, src.raw_pts, low_fps)
                    assert low.unused_indices, f"{tag}->{low_fps}fps 应出现丢帧"
                up = mapping.build_mapping(src.zero_ts, src.raw_pts, 60)
                assert up.repeat_count > 0 and len(up.unused_indices) <= 2
                # 实测短帧时间戳未被合并: 必须真实存在 0.02s 间隔
                assert any(abs(g - 0.02) < 0.003 for g in gaps if g)
            for fps in TARGET_FPS_CHOICES:
                m = mapping.build_mapping(src.zero_ts, src.raw_pts, fps)
                exported = exporter.export(
                    src, m, os.path.join(out_dir, tag.lower()),
                    f"{tag.lower()}_{fps}fps",
                )
                report = verify.verify_output(
                    src, m, exported["mp4"], src.work_dir,
                    expect_beeps=True,
                )
                assert report["passed"], report["failures"]
                # 清单与输出帧数一致且严格递增
                import csv
                with open(exported["csv"], encoding="utf-8-sig") as fh:
                    rows = list(csv.DictReader(fh))
                assert len(rows) == m.output_count
                prev = -1.0
                for r in rows:
                    cur = float(r["output_time_s"])
                    assert cur > prev
                    assert abs(cur - int(r["output_index"]) / fps) < 1e-6
                    prev = cur
            print(f"[OK] {tag} 样例在 24/25/30/60fps 下导出并通过实测核对")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> None:
    _check_mapping_uniform()
    _check_mapping_vfr()
    _check_end_to_end()
    print("\n全部检查通过。")


if __name__ == "__main__":
    main()
