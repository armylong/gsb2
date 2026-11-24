"""GUI 冒烟测试：QT_QPA_PLATFORM=offscreen 下走完整交互路径。"""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtWidgets import QApplication

from chroma_inspector.chroma import ChromaSite
from chroma_inspector.media import open_media
from chroma_inspector.patterns import generate_all
from chroma_inspector.ui.main_window import MainWindow

pytestmark = pytest.mark.skipif(
    os.system("ffmpeg -version >/dev/null 2>&1") != 0,
    reason="未安装 ffmpeg",
)


@pytest.fixture(scope="module")
def app():
    existing = QApplication.instance()
    return existing or QApplication([])


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    d = tmp_path_factory.mktemp("gui_clips")
    return generate_all(str(d))


def test_open_and_browse_planes(app, clips):
    win = MainWindow()
    path = next(p for p in clips if p.endswith("pat_horizontal.mkv"))
    win.load_media(open_media(path))
    assert win.media.frame_count == 16
    # 三平面切换
    for idx in range(3):
        win.plane_combo.setCurrentIndex(idx)
    # 跳帧
    win.frame_spin.setValue(7)
    assert win.frame_index == 7
    y, u, v = win._planes()
    assert y.shape == (192, 256) and u.shape == (96, 128)
    # 点亮度像素，状态栏应给出原始色度位置
    win.plane_combo.setCurrentIndex(0)
    win.on_plane_pixel(100, 50)
    assert "色度" in win.status.currentMessage()


def test_chroma_plane_click_reports_virtual_point(app, clips):
    """回归保护：色度平面点击必须正确调用 virtual_point(site, x, y, ...)。"""
    win = MainWindow()
    path = next(p for p in clips if p.endswith("pat_horizontal.mkv"))
    win.load_media(open_media(path))
    win.plane_combo.setCurrentIndex(1)  # Cb
    win.on_plane_pixel(10, 8)
    msg = win.status.currentMessage()
    assert "色度样本 (10,8)" in msg
    assert "虚拟位置" in msg
    # left 解释下样本 (10,8) 虚拟亮度坐标 (20,16)
    assert "(20, 16)" in msg
    win.plane_combo.setCurrentIndex(2)  # Cr
    win.on_plane_pixel(0, 0)
    assert "色度样本 (0,0)" in win.status.currentMessage()


def test_compare_mode_and_diff(app, clips):
    win = MainWindow()
    path = next(p for p in clips if p.endswith("pat_vertical.mkv"))
    win.load_media(open_media(path))
    win.rb_compare.setChecked(True)
    assert win.stack.currentWidget() is win.compare_widget
    # 默认 A/B 应是两个不同的可用解释
    sa, sb = win.site_a.currentData(), win.site_b.currentData()
    assert sa != sb
    # 切换解释触发刷新不报错
    win.site_a.setCurrentIndex(0)
    win.chk_diff.setCurrentIndex(1)
    assert win.diff_view.maximumHeight() > 0
    # 中性检查文字
    assert "中性" in win.status.currentMessage() or "色度" in win.status.currentMessage()


def test_lock_region_and_export(app, clips, tmp_path):
    win = MainWindow()
    path = next(p for p in clips if p.endswith("pat_horizontal.mkv"))
    win.load_media(open_media(path))
    win.rb_compare.setChecked(True)
    win.on_region_locked((120, 90, 140, 110))
    assert win.locked_region == (120, 90, 140, 110)
    out = tmp_path / "check.png"
    from chroma_inspector.ui.export_png import render_png
    from chroma_inspector.reconstruct import reconstruct_rgb
    m = win.media
    y, u, v = win._planes()
    rgb_a = reconstruct_rgb(y, u, v, m.pixel_format, ChromaSite.LEFT,
                             m.matrix_key, m.full_range)
    rgb_b = reconstruct_rgb(y, u, v, m.pixel_format, ChromaSite.CENTER,
                             m.matrix_key, m.full_range)
    render_png(rgb_a, rgb_b, "A left", "B center", "帧号 3", str(out),
               zoom_crop=(120, 90, 140, 110))
    assert out.exists() and out.stat().st_size > 0


def test_declaration_panel_per_file(app, clips):
    win = MainWindow()
    declared = next(p for p in clips if p.endswith("pat_fine_lines.mkv"))
    unspecified = next(p for p in clips if p.endswith("pat_neutral.mkv"))
    win.load_media(open_media(declared))
    assert "center" in win.decl_text.toPlainText()
    win.load_media(open_media(unspecified))
    panel = win.decl_text.toPlainText()
    assert "未声明" in panel
    assert "center" not in panel.split("实际选用")[0]


def test_raw_open_via_dialog_data(app, clips):
    from chroma_inspector.media import open_raw

    win = MainWindow()
    raw = next(p for p in clips if p.endswith("pat_neutral.yuv"))
    win.load_media(open_raw(raw, 256, 192, "yuv420p"))
    assert win.media.is_raw
    assert "无容器" in win.decl_text.toPlainText()
