"""GUI 层测试：在 offscreen Qt 平台验证交互逻辑，无需真实显示器。"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication, QMessageBox  # noqa: E402

from greenscreen.app.main_window import MainWindow  # noqa: E402
from greenscreen.keying import KeyingParams  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def window(qapp, assets):
    win = MainWindow()
    win.show()  # offscreen 下也要 show，控件才有非零尺寸
    qapp.processEvents()
    win.load_background(str(assets["background"]))
    win.load_foreground(str(assets["video"]))
    qapp.processEvents()
    yield win
    win.close()
    if win.reader:
        win.reader.close()


def test_three_views_render_same_frame(window, qapp):
    """加载后三个画面都有图，且共享同一个当前帧号。"""
    qapp.processEvents()
    assert not window.view_original._pixmap.isNull()
    assert not window.view_foreground._pixmap.isNull()
    assert not window.view_composite._pixmap.isNull()
    assert window.current_index == 0


def test_seek_keeps_views_synchronized(window, qapp):
    """拖动时间轴后，三个画面仍对应同一时刻。"""
    target = window.reader.frame_count - 2
    window._seek(target)
    qapp.processEvents()
    assert window.current_index == target
    assert window.time_slider.value() == target
    # 原始画面确实换成了目标帧
    expected = window.reader.read_frame(target)
    np.testing.assert_array_equal(window._last_frame, expected)
    assert not window.view_composite._pixmap.isNull()


def test_param_change_re_renders(window, qapp):
    window._seek(5)
    before = window.view_composite._pixmap.toImage()
    window.params.hue_width = 0.1
    window._render()
    qapp.processEvents()
    after = window.view_composite._pixmap.toImage()
    # 像素数据应发生变化（极端缩小取色范围）
    assert not _qimage_equal(before, after)


def test_compare_buttons_do_not_mutate_params(window, qapp):
    snapshot = window.params.to_dict()
    window.btn_cmp_spill.setChecked(True)
    window.btn_cmp_protect.setChecked(True)
    qapp.processEvents()
    effective = window._effective_params()
    assert effective.despill_on is False
    assert effective.protection_on is False
    # 正式参数不受对比模式影响
    assert window.params.to_dict() == snapshot
    window.btn_cmp_spill.setChecked(False)
    window.btn_cmp_protect.setChecked(False)


def test_replay_resets_to_frame_zero(window, qapp):
    window._seek(10)
    window._replay()
    qapp.processEvents()
    try:
        assert window.current_index == 0
        assert window.playing is True
    finally:
        window._stop_play()


def test_missing_media_shows_message(window, qapp, tmp_path, monkeypatch):
    """打开不支持/缺失的素材时弹错误框，而不是崩溃或静默失败。"""
    messages = []
    monkeypatch.setattr(QMessageBox, "critical",
                        staticmethod(lambda *a, **k: messages.append(a)))
    window.load_foreground(str(tmp_path / "nope.mp4"))
    window.load_background(str(tmp_path / "nope.png"))
    qapp.processEvents()
    assert len(messages) == 2


def test_eyedropper_picks_color(window, qapp):
    window._toggle_eyedropper(True)
    frame = window.reader.read_frame(0)
    h, w = frame.shape[:2]
    b0, g0, r0 = (int(v) for v in frame[5, 5])
    window._pick_color(5, 5)
    qapp.processEvents()
    assert window.params.key_bgr == (b0, g0, r0)
    assert window.eyedropper is False  # 取色后自动退出取色模式


def _qimage_equal(img1, img2) -> bool:
    if img1.size() != img2.size():
        return False
    return bytes(img1.constBits()) == bytes(img2.constBits())
