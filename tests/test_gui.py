"""离屏 GUI 验证: 坐标映射、缩放不使选区漂移、主窗口端到端冒烟。

运行时使用 QT_QPA_PLATFORM=offscreen, 不需要真实显示器与声卡。
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest
import soundfile as sf
from PySide6.QtCore import QPoint, Qt

from PySide6.QtWidgets import QApplication

from audio_repair.main_window import MainWindow
from audio_repair.widgets.spectrogram import (
    SpectrogramView, ViewRect, WaveformView, nice_ticks,
)

SR = 44100


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


def _stereo_audio(dur=3.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return np.stack([
        0.3 * np.sin(2 * np.pi * 300 * t),
        0.3 * np.sin(2 * np.pi * 450 * t),
    ], axis=1)


# ---------------------------------------------------------------------------

def test_nice_ticks_are_readable():
    ticks = nice_ticks(0.0, 1.0, max_ticks=5)
    assert ticks[0] == pytest.approx(0.0)
    assert ticks[-1] <= 1.0 + 1e-9
    assert len(ticks) <= 7


def test_coordinate_roundtrip(qapp):
    view = SpectrogramView()
    audio = _stereo_audio()
    view.resize(900, 500)
    view.set_audio(audio, SR)
    for t in (0.0, 0.37, 1.5, 2.99):
        x = view.time_to_x(t)
        assert abs(view.x_to_time(x) - t) < 2e-3
    for f in (0.0, 1234.0, 18000.0, SR / 2):
        y = view.freq_to_y(f)
        assert abs(view.y_to_freq(y) - f) < 1.0


def test_selection_does_not_drift_on_zoom(qapp):
    """核心要求: 改变显示缩放, 实际选区 (秒/Hz) 必须保持不变。"""
    view = SpectrogramView()
    view.resize(1000, 600)
    view.set_audio(_stereo_audio(), SR)
    rect = ViewRect(int(0.5 * SR), int(1.2 * SR), 2000.0, 5000.0)
    view.set_rect(rect)

    for _ in range(5):
        view.zoom_time(1 / 1.6)
        view.zoom_freq(1 / 1.6)
    for _ in range(3):
        view.zoom_time(1.6)
        view.zoom_freq(1.6)
    view.reset_view()

    assert view.selection_rect() is not None
    assert view.selection_rect().start_sample == rect.start_sample
    assert view.selection_rect().end_sample == rect.end_sample
    assert view.selection_rect().f0 == pytest.approx(rect.f0)
    assert view.selection_rect().f1 == pytest.approx(rect.f1)


def test_drag_creates_absolute_selection(qapp):
    view = SpectrogramView()
    view.resize(1000, 600)
    view.set_audio(_stereo_audio(), SR)
    r = view.plot_rect()
    # 模拟在绘图区内拖拽
    p0 = QPoint(int(r.left() + 100), int(r.bottom() - 150))
    p1 = QPoint(int(r.left() + 300), int(r.top() + 80))
    view.mousePressEvent(_mouse_event(p0, Qt.LeftButton))
    view.mouseMoveEvent(_mouse_event(p1, Qt.LeftButton))
    view.mouseReleaseEvent(_mouse_event(p1, Qt.LeftButton))
    rect = view.selection_rect()
    assert rect is not None
    t0 = view.x_to_time(r.left() + 100)
    t1 = view.x_to_time(r.left() + 300)
    assert rect.start_sample / SR == pytest.approx(t0, abs=2e-3)
    assert rect.end_sample / SR == pytest.approx(t1, abs=2e-3)
    assert rect.f1 > rect.f0


def test_tiny_drag_clears_selection(qapp):
    view = SpectrogramView()
    view.resize(1000, 600)
    view.set_audio(_stereo_audio(), SR)
    view.set_rect(ViewRect(100, 200, 1000.0, 2000.0))
    r = view.plot_rect()
    p = QPoint(int(r.left() + 100), int(r.top() + 100))
    view.mousePressEvent(_mouse_event(p, Qt.LeftButton))
    view.mouseReleaseEvent(_mouse_event(p, Qt.LeftButton))
    assert view.selection_rect() is None   # 空选区有反馈且不残留


def test_channel_switching(qapp):
    view = SpectrogramView()
    view.set_audio(_stereo_audio(), SR)
    assert view.n_channels == 2
    view.set_channel(1)
    assert view.channel == 1
    view.set_channel(99)         # 越界夹紧
    assert view.channel == 1


def test_update_audio_keeps_view_and_selection(qapp):
    view = SpectrogramView()
    view.resize(1000, 600)
    view.set_audio(_stereo_audio(), SR)
    view.zoom_time(1 / 2.0)
    view.zoom_freq(1 / 2.0)
    rect = ViewRect(1000, 2000, 1500.0, 3000.0)
    view.set_rect(rect)
    t_view, f_view = view._t_view, view._f_view
    # 模拟预览刷新: 数据换了, 视口与选区必须原样保留
    view.update_audio_keep_view(_stereo_audio() * 0.5)
    assert view._t_view == t_view
    assert view._f_view == f_view
    assert view.selection_rect() == rect


def test_waveform_selection_range(qapp):
    w = WaveformView()
    w.resize(900, 200)
    audio = _stereo_audio()
    w.set_audio(audio, SR)
    w.set_selection_range(100, 200)
    w.set_selection_range(None, None)
    assert w._sel_range is None


# ---------------------------------------------------------------------------
# 主窗口端到端 (不触发真实声卡)
# ---------------------------------------------------------------------------

def test_main_window_full_flow(qapp, tmp_path):
    path = tmp_path / "s.wav"
    sf.write(str(path), _stereo_audio(), SR, subtype="PCM_16")
    win = MainWindow()
    win.doc.load(str(path))
    win.spec.set_audio(win.doc.confirmed, SR, 0)
    win.wave.set_audio(win.doc.confirmed, SR)
    win._init_channel_controls()

    # 框选
    rect = ViewRect(int(0.4 * SR), int(1.0 * SR), 2400.0, 3600.0)
    win.on_selection_dragged(rect)
    assert win._current_selection().channels == (0, 1)

    # 建立并确认一次衰减处理
    win._rebuild_preview()
    assert win.doc.has_preview
    assert "未确认预览" in win.lbl_preview.text()
    win.commit()
    assert win.doc.can_undo
    assert not win.doc.has_preview

    # 撤销恢复两侧
    win.doc.undo()
    data, _ = sf.read(str(path), dtype="float64")
    np.testing.assert_allclose(win.doc.confirmed, data, atol=2e-4)

    # 仅处理右声道: 左声道不动
    win.rb_right.setChecked(True)
    win._rebuild_preview()
    assert win._current_selection().channels == (1,)
    win.commit()
    np.testing.assert_allclose(win.doc.confirmed[:, 0], data[:, 0], atol=2e-4)

    # 恢复原文件 + 导出
    win.doc.restore_original()
    out = tmp_path / "out.wav"
    win.doc.export(str(out))
    disk, sr_out = sf.read(str(out), dtype="float64")
    assert sr_out == SR
    np.testing.assert_allclose(disk, data, atol=2e-4)
    win.player.stop()
    win.close()


def test_main_window_cancel_discards_preview(qapp, tmp_path):
    path = tmp_path / "s.wav"
    sf.write(str(path), _stereo_audio(2.0), SR, subtype="PCM_16")
    win = MainWindow()
    win.doc.load(str(path))
    before = win.doc.confirmed.copy()
    win.on_selection_dragged(
        ViewRect(int(0.2 * SR), int(0.8 * SR), 2000.0, 4000.0))
    win._rebuild_preview()
    win.cancel_preview()
    np.testing.assert_array_equal(win.doc.confirmed, before)
    win.player.stop()
    win.close()


def test_inpaint_failure_falls_back_to_attenuate(qapp, tmp_path, monkeypatch):
    """邻域修补缺少参考时弹窗, 选择 '是' 自动改用衰减并成功建立预览。"""
    from PySide6.QtWidgets import QMessageBox
    monkeypatch.setattr(QMessageBox, "question",
                        staticmethod(lambda *a, **k: QMessageBox.Yes))
    path = tmp_path / "s.wav"
    sf.write(str(path), _stereo_audio(2.0), SR, subtype="PCM_16")
    win = MainWindow()
    win.doc.load(str(path))
    win.spec.set_audio(win.doc.confirmed, SR, 0)
    win.wave.set_audio(win.doc.confirmed, SR)
    win._init_channel_controls()
    win.rb_inp.setChecked(True)
    # 选区顶到奈奎斯特, inpaint 必然拒绝
    win.on_selection_dragged(
        ViewRect(int(0.2 * SR), int(0.6 * SR), 18000.0, SR / 2))
    win._rebuild_preview()
    assert win.doc.has_preview
    assert win.rb_att.isChecked()      # 已自动切回衰减
    assert win.doc.preview.options.mode == "attenuate"
    win.player.stop()
    win.close()


# ---------------------------------------------------------------------------

class _FakeMouseEvent:
    def __init__(self, pos: QPoint, button):
        self._pos = pos
        self._button = button

    def position(self):
        from PySide6.QtCore import QPointF
        return QPointF(self._pos)

    def button(self):
        return self._button


def _mouse_event(pos: QPoint, button):
    return _FakeMouseEvent(pos, button)
