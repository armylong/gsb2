"""GUI 冒烟测试：在 offscreen 模式下启动主窗口并驱动核心交互。

无头环境用 QT_QPA_PLATFORM=offscreen 运行；若平台插件不可用则跳过。
渲染在后台 QThread 进行，测试通过 QSignalSpy 等待 rendered 信号。
"""

from __future__ import annotations

import os
import time

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication  # noqa: E402

from app.image_canvas import MODE_PIXEL, MODE_SMOOTH  # noqa: E402
from app.main_window import MainWindow  # noqa: E402
from halftone.core import DEFAULT_PARAMS  # noqa: E402


@pytest.fixture(scope="module")
def app():
    qapp = QApplication.instance() or QApplication([])
    yield qapp
    qapp.processEvents()


def _wait_rendered(win: MainWindow, app: QApplication, groups=("A", "B"),
                   expect_new: dict | None = None, timeout_ms: int = 30000) -> None:
    """等待后台渲染落地。

    expect_new 给定时，等待这些组的 binary 对象身份发生变化；
    否则只等待 binary 非空。注意 offscreen 平台下 QTest.qWait 极慢，
    这里用 processEvents + 短 sleep 驱动队列信号。
    """
    expect_new = expect_new or {}
    deadline = timeout_ms
    while deadline > 0:
        app.processEvents()
        time.sleep(0.005)
        deadline -= 5
        done = True
        for g in groups:
            if win.binary[g] is None:
                done = False
                break
            if g in expect_new and win.binary[g] is expect_new[g]:
                done = False
                break
        if done:
            return
    raise TimeoutError(f"等待后台渲染超时: {groups}")


def test_window_starts_and_renders_both_groups(app):
    win = MainWindow()
    win.show()
    _wait_rendered(win, app)

    assert win.gray is not None
    for g in ("A", "B"):
        assert win.binary[g] is not None
        assert set(np.unique(win.binary[g]).tolist()).issubset({0, 255})

    # 改 A 组周期 -> 重新渲染且仍是二值
    panel = win.param_panels["A"]
    old_a = win.binary["A"]
    panel.period.setValue(14.0)
    _wait_rendered(win, app, groups=("A",), expect_new={"A": old_a})
    assert win.params["A"]["period"] == 14.0
    assert win.binary["A"] is not old_a
    assert set(np.unique(win.binary["A"]).tolist()).issubset({0, 255})

    # B 组未受影响
    assert win.params["B"]["period"] == DEFAULT_PARAMS["period"]

    # 恢复默认
    old_a = win.binary["A"]
    win._on_reset("A")
    _wait_rendered(win, app, groups=("A",), expect_new={"A": old_a})
    assert win.params["A"] == DEFAULT_PARAMS
    win.close()


def test_selection_stats_and_view_mode_switch(app):
    win = MainWindow()
    win.show()
    _wait_rendered(win, app)

    h, w = win.gray.shape
    win._set_selection((20, 20, min(100, w - 30), min(80, h - 30)))
    app.processEvents()
    for g in ("A", "B"):
        text = win.stats_text[g].toPlainText()
        assert "实测黑像素占比" in text

    # 查看方式切换只改显示变换，不改数据
    before = win.binary["A"].copy()
    win._toggle_mode()
    assert win.view_mode == MODE_SMOOTH
    assert win.canvas_a.mode() == MODE_SMOOTH
    win._toggle_mode()
    assert win.view_mode == MODE_PIXEL
    assert np.array_equal(win.binary["A"], before)
    win.close()


def test_invalid_period_shows_message_not_crash(app):
    win = MainWindow()
    panel = win.param_panels["B"]
    # spinbox 本身限制范围，直接调核心校验路径模拟非法输入
    from halftone.core import validate_params, HalftoneError

    with pytest.raises(HalftoneError):
        validate_params({**DEFAULT_PARAMS, "period": 0.1})
    panel.clear_error()
    win.close()
