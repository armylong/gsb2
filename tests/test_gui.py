"""GUI 无头冒烟: 用 Qt offscreen 平台实例化主窗口并走一遍主要交互。"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from panel_splitter.gui.canvas import (
    MODE_DRAG_SEAM,
    MODE_MERGE,
    MODE_SPLIT_V,
)
from panel_splitter.gui.main_window import MainWindow


def main():
    app = QApplication([])
    win = MainWindow()
    win.resize(1280, 860)
    win.show()
    app.processEvents()

    # 1) 生成演示页并自动切分
    win.load_demo()
    app.processEvents()
    assert win.model is not None
    n0 = len(win.model.panels)
    print(f"[GUI] 演示页装载, 初次切分 {n0} 格")

    # 2) 切到补竖缝模式, 在最大连体格中心模拟点击
    win._set_mode(MODE_SPLIT_V)
    canvas = win.canvas
    big = max(
        range(len(canvas.model.panels)),
        key=lambda i: (
            (canvas.model.panels[i][2] - canvas.model.panels[i][0])
            * (canvas.model.panels[i][3] - canvas.model.panels[i][1])
        ),
    )
    x0, y0, x1, y1 = canvas.model.panels[big]
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    screen = canvas.to_screen(cx, cy)
    from PySide6.QtGui import QMouseEvent
    from PySide6.QtCore import QEvent
    press = QMouseEvent(
        QEvent.Type.MouseButtonPress, screen,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    QApplication.sendEvent(canvas, press)
    app.processEvents()
    assert len(win.model.panels) == n0 + 1, "补竖缝后面板数应 +1"
    print("[GUI] 补竖缝 OK, 面板数 =", len(win.model.panels))

    # 3) 拖缝模式: 模拟在某条横缝上按下并移动
    win._set_mode(MODE_DRAG_SEAM)
    target = None
    for (px0, py0, px1, py1) in canvas.model.panels:
        if py0 > 100:
            target = py0
            sx = (px0 + px1) // 2
            break
    assert target is not None
    p1 = canvas.to_screen(sx, target)
    press = QMouseEvent(
        QEvent.Type.MouseButtonPress, p1,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    QApplication.sendEvent(canvas, press)
    p2 = canvas.to_screen(sx, target + 12)
    move = QMouseEvent(
        QEvent.Type.MouseMove, p2,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    QApplication.sendEvent(canvas, move)
    release = QMouseEvent(
        QEvent.Type.MouseButtonRelease, p2,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    QApplication.sendEvent(canvas, release)
    app.processEvents()
    print("[GUI] 拖缝交互 OK")

    # 4) 框选合并底行两块
    win._set_mode(MODE_MERGE)
    bottom = [p for p in canvas.model.panels if p[1] > canvas.image_shape[0] * 0.7]
    assert len(bottom) >= 2
    bx0 = min(p[0] for p in bottom)
    by0 = min(p[1] for p in bottom)
    bx1 = max(p[2] for p in bottom)
    by1 = max(p[3] for p in bottom)
    tl = canvas.to_screen(bx0 + 5, by0 + 5)
    br = canvas.to_screen(bx1 - 5, by1 - 5)
    QApplication.sendEvent(canvas, QMouseEvent(
        QEvent.Type.MouseButtonPress, tl,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier))
    QApplication.sendEvent(canvas, QMouseEvent(
        QEvent.Type.MouseMove, br,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier))
    QApplication.sendEvent(canvas, QMouseEvent(
        QEvent.Type.MouseButtonRelease, br,
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier))
    app.processEvents()
    print("[GUI] 框选合并 OK, 面板数 =", len(win.model.panels))

    # 5) 方向切换 + 顺序列表
    win.direction.setCurrentIndex(1)
    app.processEvents()
    rtl_order = list(win.order_list._indices)
    win.direction.setCurrentIndex(0)
    app.processEvents()
    ltr_order = list(win.order_list._indices)
    assert rtl_order != ltr_order
    print("[GUI] LTR/RTL 切换 OK")

    # 6) 撤销/重做
    win._undo()
    app.processEvents()
    win._redo()
    app.processEvents()
    print("[GUI] 撤销/重做 OK")

    # 7) 导出 (绕过目录对话框, 直接调核心)
    from panel_splitter.exporting import export_panels
    from panel_splitter.ordering import compute_order
    with tempfile.TemporaryDirectory() as tmp:
        info = compute_order(win.model.panels, "ltr")
        items, manifest, review = export_panels(
            win.image_bgr, win.model.panels, info, tmp, margin_px=4
        )
        assert len(items) == len(win.model.panels)
        assert os.path.exists(manifest) and os.path.exists(review)
    print("[GUI] 导出 OK,", len(items), "张小图")

    print("\nGUI 无头冒烟全部通过 ✔")


if __name__ == "__main__":
    main()
