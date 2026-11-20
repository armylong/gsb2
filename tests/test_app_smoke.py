"""GUI 冒烟测试: 离屏实例化主窗口, 载入样例, 自动估计, 导出。"""
import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication

from scanprep.samples.generator import generate_samples


@pytest.fixture(scope="module")
def app():
    a = QApplication.instance() or QApplication([])
    yield a


def test_mainwindow_flow(app, tmp_path, monkeypatch):
    from scanprep.ui.app import MainWindow

    generate_samples(tmp_path)
    win = MainWindow()
    win._load_file(tmp_path / "text_tilt_p32.png")
    assert win.auto_estimate is not None
    assert abs(win.auto_estimate.angle - (-3.2)) <= 0.3
    assert win.result is not None

    # 切换输出模式与参数, 结果应更新且一致
    win.rb_bin.setChecked(True)
    assert win.result.image is not None
    win.rb_gray.setChecked(True)

    # 导出 (拦截文件对话框)
    out = tmp_path / "export.png"
    monkeypatch.setattr(
        "scanprep.ui.app.QFileDialog.getSaveFileName",
        staticmethod(lambda *a, **k: (str(out), "PNG (*.png)")))
    win._export()
    assert out.exists()
    assert out.with_suffix(".json").exists()
    # 原稿未被覆盖
    assert (tmp_path / "text_tilt_p32.png").exists()
