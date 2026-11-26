"""GUI 冒烟测试 (offscreen): 直接驱动 MainWindow, 覆盖交互与状态保持。"""

import os
import tempfile

from PySide6.QtCore import QPointF

from bandview.app import VIEW_COMPOSITE, MainWindow
from bandview.generate import generate_sample_dataset
from bandview.io_utils import load_band, load_settings_json, save_rgba_png
from bandview.rendering import render_composite


def _app():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    return app


def _load_sample(win: MainWindow, tmpdir: str) -> dict:
    meta = generate_sample_dataset(tmpdir)
    for name in meta["band_names"]:
        band = load_band(os.path.join(tmpdir, f"{name}.npy"), nodata=0)
        win._register_band(band)
    win._after_bands_changed()
    return meta


def test_full_window_flow():
    _app()
    with tempfile.TemporaryDirectory() as tmp:
        win = MainWindow()
        meta = _load_sample(win, tmp)
        names = meta["band_names"]

        # 初始视图: 合成 + 4 张灰度
        assert set(win.canvases) == {VIEW_COMPOSITE, *[f"band:{n}" for n in names]}

        # 分配 b1/b3/b4 到 R/G/B
        combos = win.channel_panel.combos()
        for combo, name in zip(combos, ("b1", "b3", "b4")):
            combo.setCurrentIndex(combo.findData(name))
        assert win.assignment == ("b1", "b3", "b4")
        win.refresh_views()  # 立即刷新, 不等防抖

        comp = win.canvases[VIEW_COMPOSITE]
        assert not comp._pixmap_item.pixmap().isNull()

        # ---- 通道替换后其它图与手动范围保留 ----
        saved_ranges = dict(win.manual_ranges)
        combos[0].setCurrentIndex(combos[0].findData("b2"))
        assert win.assignment[0] == "b2"
        assert win.manual_ranges == saved_ranges
        # 灰度视图一张没少
        assert all(f"band:{n}" in win.canvases for n in names)

        # ---- 手动改共同范围, 所有波段同步 ----
        lo_spin, hi_spin = win.stretch_panel.spins["common"]
        lo_spin.setValue(2000.0)
        hi_spin.setValue(5000.0)
        win.stretch_panel.range_edited.emit("common", 2000.0, 5000.0)
        assert all(v == (2000.0, 5000.0) for v in win.manual_ranges.values())

        # 切换到各通道单独拉伸不丢数据
        win.stretch_panel.rb_per.setChecked(True)
        win.refresh_views()
        win.stretch_panel.rb_common.setChecked(True)

        # ---- 参考区: 统计范围随 ROI 变化 ----
        assert win.roi is None
        win.on_canvas_roi("composite", (10, 10, 60, 60))
        assert win.roi == (10, 10, 60, 60)
        roi_stats = win.bands["b1"].stats_in(win.roi)
        full_stats = win.bands["b1"].stats_in(None)
        assert roi_stats.count == 50 * 50 - int(
            (~win.bands["b1"].valid[10:60, 10:60]).sum()
        )
        assert roi_stats.count < full_stats.count
        # ROI 同步到了每个画布
        assert all(c.roi() == (10, 10, 60, 60) for c in win.canvases.values())
        # 自动范围只在显式点击时覆盖手动值; 切到「参考区取范围」
        win.stretch_panel.rb_roi.setChecked(True)
        win.action_apply_auto()
        assert win.manual_ranges["b1"] == (roi_stats.minimum, roi_stats.maximum)
        win.stretch_panel.rb_full.setChecked(True)
        win.action_clear_roi()
        assert win.roi is None

        # ---- 视图共享 transform 与十字线 ----
        c0 = win.canvases[VIEW_COMPOSITE]
        c1 = win.canvases["band:b1"]
        before = c0.transform().m11()
        c0.scale(2.0, 2.0)
        win.sync_group.broadcast_transform(c0)
        # 联动后两画布 transform 完全相同 (同一图像坐标), 且缩放翻倍
        assert abs(c1.transform().m11() - c0.transform().m11()) < 1e-12
        assert abs(c1.transform().m11() - 2.0 * before) < 1e-9
        c0.set_crosshair(QPointF(12.5, 7.25))
        win.sync_group.broadcast_crosshair(c0, QPointF(12.5, 7.25))
        assert c1._crosshair_v.isVisible()

        # ---- 像素读数用原像素整数坐标 ----
        win.on_cursor(VIEW_COMPOSITE, QPointF(12.6, 7.8))
        assert "x=12, y=7" in win.info_label.text()
        assert "原始" in win.info_label.text()
        win.on_cursor(VIEW_COMPOSITE, None)

        # ---- NDVI 视图出现、交换反号由渲染层保证, 这里只查联动 ----
        win.ndvi_panel.combo_a.setCurrentIndex(win.ndvi_panel.combo_a.findData("b4"))
        win.ndvi_panel.combo_b.setCurrentIndex(win.ndvi_panel.combo_b.findData("b3"))
        win.refresh_views()
        assert "ndvi" in win.canvases
        assert win._ndvi_cache is not None
        leaf_x, leaf_y = meta["leaf_pixel"]
        ndvi_value = win._ndvi_cache["ndvi"][leaf_y, leaf_x]
        assert ndvi_value > 0.3  # 树叶在 b4 明显强于 b3
        win.ndvi_panel.swap_btn.click()
        win.refresh_views()
        swapped = win._ndvi_cache["ndvi"][leaf_y, leaf_x]
        assert abs(swapped + ndvi_value) < 1e-9

        # ---- 导出合成图与设置, 再导回 ----
        out_png = os.path.join(tmp, "composite.png")
        band_tuple = tuple(win.bands.get(n) if n else None for n in win.assignment)
        rgba = render_composite(band_tuple, win._current_ranges(), True)
        save_rgba_png(out_png, rgba)
        assert os.path.getsize(out_png) > 0

        out_json = os.path.join(tmp, "settings.json")
        from bandview.io_utils import save_settings_json

        save_settings_json(out_json, win._settings_dict())
        settings = load_settings_json(out_json)
        assert settings["assignment"] == list(win.assignment)
        assert settings["ndvi"]["a"] == "b3"  # 交换后

        win2 = MainWindow()
        win2._apply_settings(settings)
        win2.refresh_views()
        assert win2.assignment == win.assignment
        assert win2.band_order == win.band_order
        assert "ndvi" in win2.canvases


def test_roi_clipped_to_pixel_bounds():
    _app()
    with tempfile.TemporaryDirectory() as tmp:
        win = MainWindow()
        _load_sample(win, tmp)
        win.refresh_views()
        # 越界参考区统计时自动裁回图像
        stats = win.bands["b1"].stats_in((-50, -20, 9999, 9999))
        assert stats.count == int(win.bands["b1"].valid.sum())


def test_remove_band_keeps_others():
    _app()
    with tempfile.TemporaryDirectory() as tmp:
        win = MainWindow()
        _load_sample(win, tmp)
        win.action_remove_band(0)
        assert "b1" not in win.bands
        assert len(win.band_order) == 3
        assert "band:b1" not in win.canvases
        assert "band:b2" in win.canvases
