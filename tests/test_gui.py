"""GUI 冒烟测试（offscreen）：窗口能构建、演示图能处理、溯源与脏状态联动。

无显示环境（CI）下自动跳过；本地可用 `QT_QPA_PLATFORM=offscreen pytest` 强制运行。
"""

import os

import numpy as np
import pytest

pytest.importorskip("PySide6")
if os.environ.get("QT_QPA_PLATFORM", "") == "":
    os.environ["QT_QPA_PLATFORM"] = "offscreen"

try:
    from PySide6.QtWidgets import QApplication
except Exception:  # pragma: no cover - 无 Qt 平台插件时跳过
    pytest.skip("当前环境无法初始化 Qt", allow_module_level=True)

from app.main_window import MainWindow  # noqa: E402
from content_aware import demos  # noqa: E402


@pytest.fixture(scope="module")
def app():
    existing = QApplication.instance()
    qapp = existing or QApplication([])
    yield qapp


def _process(qapp, win, timeout_ms=20000):
    """驱动事件循环直到处理线程结束。"""
    deadline = timeout_ms
    import time

    start = time.monotonic()
    while win.worker is not None and win.worker.isRunning():
        qapp.processEvents()
        if (time.monotonic() - start) * 1000 > deadline:
            raise TimeoutError("处理线程未在限定时间内结束")
    qapp.processEvents()


def test_window_builds_and_demo_runs(app):
    win = MainWindow()
    win.load_demo()
    assert win.image is not None
    h, w = win.image.shape[:2]

    # 目标滑条范围 = 75% ~ 100% 原宽
    assert win.slider_target.minimum() == int(round(w * 0.75))
    assert win.slider_target.maximum() == w

    target = int(round(w * 0.85))
    win.slider_target.setValue(target)
    win.start_process()
    _process(app, win)

    assert win.outcome is not None and win.outcome.completed
    assert win.outcome.width == target and win.outcome.height == h
    assert not win.dirty
    assert win.btn_export.isEnabled()


def test_protected_drawing_marks_dirty_and_blocks_removal(app):
    win = MainWindow()
    win.load_demo()
    h, w = win.image.shape[:2]
    target = int(round(w * 0.8))
    win.slider_target.setValue(target)
    win.start_process()
    _process(app, win)
    assert win.outcome.completed

    # 直接在共享掩码上模拟一笔保护，并发出视图信号 -> 应变脏、禁止导出
    win.mask[80:140, 60:180] = True
    win.source_view.set_mask(win.mask)
    win._on_mask_edited()
    assert win.dirty and not win.btn_export.isEnabled()

    win.start_process()
    _process(app, win)
    # 保护像素全部保留
    removed = {(x, y) for y, x in win.outcome.removed_source_points}
    for py, px in np.argwhere(win.mask):
        assert (int(px), int(py)) not in removed


def test_pick_result_pixel_maps_to_source(app):
    win = MainWindow()
    win.load_demo()
    h, w = win.image.shape[:2]
    win.slider_target.setValue(int(round(w * 0.85)))
    win.start_process()
    _process(app, win)

    rx, ry = 5, 10
    win.pick_result_pixel(rx, ry)
    src_x = int(win.outcome.source_index[ry, rx])
    assert win._marker_src == (src_x, ry)
    # 源图与结果在该点颜色一致（真实像素搬运）
    assert np.array_equal(
        win.image[ry, src_x], win.outcome.result[ry, rx]
    )


def test_blocked_demo_stops_and_keeps_last_valid(app):
    win = MainWindow()
    win.load_blocked_demo()
    h, w = win.image.shape[:2]
    win.slider_target.setValue(int(round(w * 0.8)))
    win.start_process()
    _process(app, win)

    out = win.outcome
    assert out.stopped_infeasible and not out.completed
    assert out.width == w and len(out.removed_seams) == 0
    # 未完成但非取消：允许导出，但元数据如实记录未完成（导出按钮可用）
    assert win.btn_export.isEnabled()


def test_brush_mapping_stays_accurate_under_zoom_and_pan(app):
    """缩放平移后，图上盖章仍准确落在源图像素上（笔迹坐标与源图对齐）。"""
    from PySide6.QtCore import QPointF

    from app.widgets import ImageView

    view = ImageView()
    image, _ = demos.make_demo_scene(width=400, height=240)
    view.set_image(image)
    view.set_mode("protect")
    view.set_brush_size(10)
    view.resize(600, 400)
    app.processEvents()

    target_x, target_y = 200.0, 120.0
    # 任意变换：放大 2.5 倍再平移
    view.resetTransform()
    view.scale(2.5, 2.5)
    view.horizontalScrollBar().setValue(130)
    view.verticalScrollBar().setValue(70)
    app.processEvents()

    # 把“源图坐标”经场景->视图换算成鼠标视口坐标，再走和真实笔迹相同的盖章路径
    scene_pt = QPointF(target_x, target_y)
    viewport_pt = view.mapFromScene(scene_pt)
    view._drawing = True
    view._last_pos = None
    view._paint_stroke(viewport_pt)
    app.processEvents()

    # 掩码圆心必须正好覆盖目标源像素，且没有跑到远处
    assert view._mask[int(target_y), int(target_x)]
    ys, xs = np.where(view._mask)
    assert abs(xs.mean() - target_x) <= 6
    assert abs(ys.mean() - target_y) <= 6
    assert xs.max() - xs.min() <= 12 and ys.max() - ys.min() <= 12


def test_cancel_keeps_previous_result_and_blocks_export(app):
    win = MainWindow()
    win.load_demo()
    h, w = win.image.shape[:2]
    win.slider_target.setValue(int(round(w * 0.85)))
    win.start_process()
    _process(app, win)
    good = win.outcome

    # 第二次处理立即取消
    win.slider_target.setValue(int(round(w * 0.75)))
    win.start_process()
    win.cancel_process()
    _process(app, win)
    assert win.outcome.cancelled
    assert not win.btn_export.isEnabled()      # 半成品不得导出为完成结果
    # 上次完成结果的数据仍保留在 outcome 中且映射自洽
    rows = np.arange(good.height)[:, None]
    assert np.array_equal(win.image[rows, good.source_index], good.result)
