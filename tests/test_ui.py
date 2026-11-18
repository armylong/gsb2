"""UI 冒烟测试: offscreen 模式启动主窗口、模拟建项目与关键帧交互。

CI/无显示环境用 QT_QPA_PLATFORM=offscreen 运行。
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from fractions import Fraction  # noqa: E402

import pytest  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from pipeditor.model import Project  # noqa: E402
from pipeditor.ui.canvas import CanvasView  # noqa: E402
from pipeditor.ui.main_window import MainWindow  # noqa: E402


@pytest.fixture(scope="module")
def app():
    existing = QApplication.instance()
    return existing or QApplication([])


def test_main_window_constructs(app):
    win = MainWindow()
    win.show()
    assert win.windowTitle()
    # 三个核心区域同屏可见
    assert win.canvas.isVisible()
    assert win.kf_list is not None
    assert win.slider is not None
    win.close()


def test_canvas_coordinate_roundtrip(app):
    """显示坐标缩放换算回画布坐标必须可逆且不依赖窗口大小。"""
    view = CanvasView()
    p = Project(
        canvas_w=1280, canvas_h=720, fps=Fraction(30, 1),
        frame_count=240, duration=8.0, overlay_w=320, overlay_h=240,
        overlay_frame_count=150,
    )
    p.upsert_keyframe(0, 100, 50)
    view.set_project(p)
    view.resize(800, 600)
    view._compute_geometry()
    for cx, cy in [(0, 0), (470, 240), (960, 480), (127, 333)]:
        dx, dy = view.canvas_to_display(cx, cy)
        back_x, back_y = view.display_to_canvas(dx, dy)
        assert abs(back_x - cx) < 0.01
        assert abs(back_y - cy) < 0.01


def test_canvas_clamps_drag_inside_canvas(app):
    view = CanvasView()
    p = Project(
        canvas_w=1280, canvas_h=720, fps=Fraction(30, 1),
        frame_count=240, duration=8.0, overlay_w=320, overlay_h=240,
        overlay_frame_count=150,
    )
    p.upsert_keyframe(0, 0, 0)
    view.set_project(p)
    view.resize(800, 600)
    view._compute_geometry()
    # 任意越界输入都被夹到合法整数范围
    assert p.clamp_position(-999, -999) == (0, 0)
    assert p.clamp_position(99999, 99999) == (960, 480)
    mid = p.clamp_position(500.7, 200.4)
    assert mid == (501, 200)  # floor(v+0.5) 四舍五入
