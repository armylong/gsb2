"""GUI 交互冒烟 (offscreen): 用 Qt 事件模拟手调区间与跨视图联动。

不是正式验收 (正式验收见 verify.py), 而是把鼠标/键盘路径也跑一遍,
确保信号槽连接、坐标换算、表格编辑在无人工点击时也成立。
"""

from __future__ import annotations

import os
import tempfile

from PySide6.QtCore import QEvent, QPoint, Qt
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import QApplication

from .model import CONFLICT, EDIT, TOO_SHORT
from .waveform import WaveformView


def _click(view: WaveformView, x: int, y: int, button=Qt.MouseButton.LeftButton,
           modifiers=Qt.KeyboardModifier.NoModifier) -> None:
    view.mousePressEvent(QMouseEvent(
        QEvent.Type.MouseButtonPress, QPoint(x, y), button, button, modifiers))
    view.mouseReleaseEvent(QMouseEvent(
        QEvent.Type.MouseButtonRelease, QPoint(x, y), button, Qt.MouseButton.NoButton,
        modifiers))


def _drag(view: WaveformView, x0: int, x1: int, y: int) -> None:
    view.mousePressEvent(QMouseEvent(
        QEvent.Type.MouseButtonPress, QPoint(x0, y), Qt.MouseButton.LeftButton,
        Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
    view.mouseMoveEvent(QMouseEvent(
        QEvent.Type.MouseMove, QPoint(x1, y), Qt.MouseButton.NoButton,
        Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
    view.mouseReleaseEvent(QMouseEvent(
        QEvent.Type.MouseButtonRelease, QPoint(x1, y), Qt.MouseButton.LeftButton,
        Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier))


def main() -> int:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    from .main_window import MainWindow

    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory() as td:
        from .examples import generate_examples
        ex_dir = os.path.join(td, "examples")
        examples = generate_examples(ex_dir)
        short = next(e for e in examples if e.name == "short_gap")

        win = MainWindow()
        win.resize(1200, 800)
        win.show()
        app.processEvents()
        win.load_files(short.wav_path, short.ann_path)
        app.processEvents()

        view = win.view_src
        check("载入后有 3 个区间", len(win.regions) == 3)
        check("初始计划状态正确",
              [p.status for p in win.plan] == [EDIT, TOO_SHORT, EDIT],
              str([p.status for p in win.plan]))

        # 1) 直接以采样坐标新建一个区间 (避免不同缩放下像素换算不稳定)
        n = win.audio.n_samples
        win.add_region(n - 600, n - 200)
        app.processEvents()
        check("新建后新增 1 个区间", len(win.regions) == 4,
              f"实际 {len(win.regions)}")

        # 2) 模拟拖右边界: 把新区间终点再拉长 100 帧
        new_idx = len(win.regions) - 1
        reg = win.regions[new_idx]
        old_end = reg.end
        r = view._plot_rect()
        y = int(r.top() + r.height() / 2)
        x_handle = int(view.sample_to_x(old_end))
        x_pull = int(view.sample_to_x(min(n - 1, old_end + 100)))
        # 先点中手柄
        view.mousePressEvent(QMouseEvent(
            QEvent.Type.MouseButtonPress, QPoint(x_handle, y),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier))
        view.mouseMoveEvent(QMouseEvent(
            QEvent.Type.MouseMove, QPoint(x_pull, y), Qt.MouseButton.NoButton,
            Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
        view.mouseReleaseEvent(QMouseEvent(
            QEvent.Type.MouseButtonRelease, QPoint(x_pull, y),
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton,
            Qt.KeyboardModifier.NoModifier))
        check("拖边后终点变化且不越界",
              win.regions[new_idx].end > old_end
              and win.regions[new_idx].end <= n,
              f"{old_end} -> {win.regions[new_idx].end}")

        # 3) 造一个冲突: 新建与第 0 个区间首尾挨住的区间
        r0 = win.regions[0]
        win.add_region(r0.end, min(n - 1, r0.end + 200))
        app.processEvents()
        conflicted = [p for p in win.plan if p.status == CONFLICT]
        check("挨住后出现冲突状态", len(conflicted) >= 2,
              f"冲突区间数 {len(conflicted)}")
        check("状态栏出现冲突提示", "冲突" in win.lbl_conflict.text())

        # 4) 成品->原声联动: 在成品视图点一下, 原声视图应出现高亮
        dst = win.view_dst
        dst.set_cursor(100)
        win._on_dst_cursor(100)
        check("成品定位原声时原声高亮已设置", win.view_src.highlight is not None)
        sources = win.engine.map_destination(100)
        check("普通位置映射为单一来源", len(sources) == 1 and sources[0].kind == "keep")

        # 5) 原声->成品: 找一个被删帧, 应得到红色 deleted 反馈
        if win.engine.deleted:
            deleted_src = win.engine.deleted[0].src_start + 2
            win._on_src_cursor(deleted_src)
            check("被删帧在原声视图给出红色反馈",
                  win.view_src.highlight is not None
                  and win.view_src.highlight.color.red() > 200)
        else:
            check("被删帧反馈 (当前无删除段, 跳过)", True)

        # 6) 表格编辑保留时长: 把第 0 行保留 ms 改成 0 (硬切)
        win.table.item(0, 3).setText("0")
        app.processEvents()
        check("表格改保留时长生效", win.regions[0].keep_ms == 0.0)

        # 7) Delete 键删除选中区间 (窗口层统一处理)
        before = len(win.regions)
        view.selected_region = new_idx
        view.setFocus()
        from PySide6.QtGui import QKeyEvent
        win.keyPressEvent(QKeyEvent(
            QEvent.Type.KeyPress, Qt.Key.Key_Delete, Qt.KeyboardModifier.NoModifier))
        check("Delete 键删除选中区间", len(win.regions) == before - 1)

        # 8) 导出并核对孤儿标注 (按引擎真实删除段计算期望值, 不依赖前面的冲突状态)
        out_base = os.path.join(td, "gui_out")
        n_orphan = win.export_outputs(out_base)
        expect_orphan = sum(
            1 for _label, src in win.marks
            if win.engine.is_source_deleted(src) is not None
        )
        check("导出孤儿标注数与引擎删除段一致", n_orphan == expect_orphan,
              f"got {n_orphan} expect {expect_orphan}")
        for suffix in (".wav", ".annotations.json", ".map.json", ".map.csv"):
            check(f"导出文件 {suffix}", os.path.getsize(out_base + suffix) > 0)

        # 9) 两个视图样本数与引擎一致
        check("成品视图帧数 == 引擎输出",
              dst.samples.shape[0] == win.engine.n_dst)

        win.close()
        app.processEvents()

    print(f"\nGUI 交互冒烟: {'全部通过 ✓' if not failures else f'{len(failures)} 项失败'}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
