"""GUI 冒烟测试：用 Qt offscreen 平台跑通主要交互，不需要显示器。

运行：.venv/bin/python -m pytest tests/test_gui_smoke.py -v
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtCore import QPointF, QEvent
from PySide6.QtGui import QMouseEvent
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt

from descreen.gui.main_window import MainWindow
from descreen.synth import make_halftone_test

_app = QApplication.instance() or QApplication([])


def _wait_worker(win: MainWindow, timeout_ms: int = 20000):
    # 先让 200ms 防抖定时器触发，再等后台线程，期间持续处理信号投递
    deadline = timeout_ms
    waited = 0
    while win.worker is None and waited < deadline:
        QTest.qWait(50)
        waited += 50
    if win.worker is not None:
        assert win.worker.wait(deadline), "后台处理超时"
    for _ in range(100):
        _app.processEvents()
        if win._processed is not None:
            return
        QTest.qWait(10)


def test_window_opens_with_synthetic_image():
    win = MainWindow()
    win._set_image(make_halftone_test(256), "synthetic_halftone.png")
    assert win.spec is not None
    assert win.spec.w == 256 and win.spec.h == 256
    assert len(win.groups) == 1
    _wait_worker(win)
    assert hasattr(win, "_processed")
    assert win._processed.shape == (256, 256)


def test_region_change_updates_spectrum():
    win = MainWindow()
    win._set_image(make_halftone_test(300), "x.png")
    win._on_region_changed(20, 30, 180, 200)
    assert win.region == (20, 30, 180, 200)
    assert win.spec is not None
    # 改选区域后峰值标注应刷新
    win.thresh_spin.setValue(5.0)
    assert isinstance(win.peaks, list)


def test_add_point_notch_creates_pair_and_processes():
    win = MainWindow()
    win._set_image(make_halftone_test(256), "x.png")
    before = len(win._current_group().notches)
    # 在频谱中心偏右上的位置点一个陷波
    cx, cy = win.spec.w / 2 + 25, win.spec.h / 2 - 25
    win._on_spectrum_point(cx, cy)
    grp = win._current_group()
    assert len(grp.notches) == before + 1
    n = grp.notches[-1]
    # 共轭对由掩膜自动处理，这里确认坐标非零且半径为正
    assert n.ru > 0 and n.rv > 0 and (n.u != 0 or n.v != 0)
    _wait_worker(win)
    assert win._processed is not None


def test_ellipse_notch_and_group_toggle():
    win = MainWindow()
    win._set_image(make_halftone_test(256), "x.png")
    win._on_spectrum_rect(150, 120, 180, 140)
    assert win._current_group().notches[-1].kind == "ellipse"

    win._new_group()
    assert len(win.groups) == 2
    win.groups[0].enabled = False
    win._refresh_group_list()
    win._schedule_process()
    _wait_worker(win)
    # 关掉第一组后处理仍能完成
    assert win._processed.shape == (256, 256)


def test_diff_view_and_compare_modes():
    win = MainWindow()
    win._set_image(make_halftone_test(200), "x.png")
    _wait_worker(win)
    for mode_id in (0, 1, 2):       # 处理后 / 原图 / 差图
        win.mode_group.button(mode_id).setChecked(True)
        win._refresh_compare()
        assert win.compare_view.scene() is not None


def test_export_roundtrip(tmp_path):
    from descreen.gui.image_utils import load_image
    win = MainWindow()
    win._set_image(make_halftone_test(160), str(tmp_path / "in.png"))
    _wait_worker(win)
    out = tmp_path / "out.png"
    from descreen.gui.image_utils import save_image
    save_image(win._processed, str(out))
    reloaded = load_image(str(out))
    assert reloaded.shape == win._processed.shape


def test_small_image_does_not_crash():
    win = MainWindow()
    small = make_halftone_test(40)
    win._set_image(small, "tiny.png")
    assert win.spec is not None
    _wait_worker(win)
    assert win._processed.shape == small.shape


def test_config_save_load(tmp_path):
    win = MainWindow()
    win._set_image(make_halftone_test(200), "x.png")
    win._on_spectrum_point(130, 90)
    cfg = tmp_path / "cfg.json"
    import json
    cfg.write_text(json.dumps({
        "feather_cpp": 0.002,
        "groups": [g.to_dict() for g in win.groups],
    }), encoding="utf-8")

    win2 = MainWindow()
    win2._set_image(make_halftone_test(200), "x.png")
    data = json.loads(cfg.read_text(encoding="utf-8"))
    from descreen.core import NotchGroup
    win2.groups = [NotchGroup.from_dict(g) for g in data["groups"]]
    win2._refresh_group_list()
    win2._schedule_process()
    _wait_worker(win2)
    assert len(win2.groups[0].notches) == 1
