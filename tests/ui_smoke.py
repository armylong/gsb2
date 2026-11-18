"""无头 UI 冒烟测试: QT_QPA_PLATFORM=offscreen 下驱动主窗口全链路。

运行:
    QT_QPA_PLATFORM=offscreen .venv/bin/python -m tests.ui_smoke
"""
from __future__ import annotations

import os
import tempfile

from PySide6.QtWidgets import QApplication

from fps_checker import TARGET_FPS_CHOICES, mapping, probe, samples, verify
from fps_checker.ui import MainWindow


def main() -> None:
    work = tempfile.mkdtemp(prefix="fpsc_ui_smoke_")
    sample_dir = os.path.join(work, "samples")
    paths = samples.generate_all(work, sample_dir)

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()

    # 直接走同步加载路径, 避免事件循环等待
    src = probe.load_video(paths["vfr"], os.path.join(work, "load"))
    win._version += 1
    win._has_beeps = True
    win._load_ready(src, win._version, type("W", (), {"cleanup_dir": lambda self: None})())

    assert win._source is not None
    assert win._out_table.rowCount() > 0
    assert win._src_table.rowCount() == src.frame_count
    print(f"[OK] 窗口加载 VFR: {src.frame_count} 源帧, "
          f"当前 {win._fps}fps 输出 {win._current_mapping().output_count} 帧")

    # 切换全部目标帧率: 表格/统计必须与设置一致, 且无残留
    seen_counts = set()
    for fps in TARGET_FPS_CHOICES:
        idx = win._fps_box.findData(fps)
        win._fps_box.setCurrentIndex(idx)
        app.processEvents()
        m = win._current_mapping()
        assert win._fps == fps
        assert win._out_table.rowCount() == m.output_count
        assert win._out_info.toPlainText().startswith(f"输出帧 #0 / {m.output_count - 1}")
        seen_counts.add(m.output_count)
    assert len(seen_counts) > 1
    print(f"[OK] 4 个帧率快速切换, 表格与映射一致: {sorted(seen_counts)} 帧")

    # 点选输出行 -> 信息面板展示真实源帧对应关系
    win._fps_box.setCurrentIndex(win._fps_box.findData(60))
    app.processEvents()
    m = win._current_mapping()
    target_row = min(37, m.output_count - 1)
    win._out_table.selectRow(target_row)
    app.processEvents()
    f = m.frames[target_row]
    assert win._index == target_row
    info = win._out_info.toPlainText()
    assert f"输出帧 #{target_row}" in info
    assert f"对应源帧: #{f.source_index}" in info
    assert f"{f.source_time:.6f}" in info
    # 请求时间不等于源帧时间时, 界面仍显示源帧真实时间(不回填)
    assert not win._out_preview.pixmap().isNull()
    print(f"[OK] 点选输出帧 {target_row}: 真实对应源帧 {f.source_index}, "
          f"请求 {f.request_time:.3f}s / 源帧 {f.source_time:.3f}s")

    # 单步、首末帧、时间定位
    win._goto_next()
    assert win._index == target_row + 1
    win._goto_prev()
    assert win._index == target_row
    win._goto_last()
    assert win._index == m.output_count - 1
    win._goto_first()
    assert win._index == 0
    win._seek.setValue(0.5)
    win._on_seek()
    assert win._index == min(int(0.5 * 60), m.output_count - 1)
    print("[OK] 播放控制: 单步/首末帧/时间定位")

    # 帧区间过滤
    win._range_from.setValue(10)
    win._range_to.setValue(20)
    win._apply_range()
    assert win._out_table.isRowHidden(9) and not win._out_table.isRowHidden(15)
    win._clear_range()
    assert not win._out_table.isRowHidden(0)
    print("[OK] 帧区间过滤与清除")

    # 源帧表: 丢弃帧必须存在且可辨认(VFR 60fps 上变换不应有丢弃, 改查 24fps)
    win._fps_box.setCurrentIndex(win._fps_box.findData(24))
    app.processEvents()
    m24 = win._current_mapping()
    win._populate_source_table()
    unused = m24.unused_indices
    assert unused, "VFR->24fps 应当出现丢弃帧"
    print(f"[OK] 丢弃源帧可辨认: {len(unused)} 个, 例 {unused[:5]}")

    # 导出 + 实测核对(覆盖 UI 导出路径的核心调用)
    out_dir = os.path.join(work, "export")
    exported = {}
    from fps_checker import exporter
    paths_out = exporter.export(
        win._source, win._current_mapping(), out_dir, "smoke_24fps",
        on_progress=lambda d, t: None,
    )
    report = verify.verify_output(
        win._source, win._current_mapping(), paths_out["mp4"],
        win._source.work_dir, expect_beeps=True,
    )
    assert report["passed"]
    assert os.path.getsize(paths_out["csv"]) > 0
    print(f"[OK] 导出并通过实测核对: {report['summary']}")
    print(f"     {paths_out['mp4']}")

    print("\nUI 冒烟测试全部通过。")


if __name__ == "__main__":
    main()
