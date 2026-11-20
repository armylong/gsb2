"""Main window: sample loading, parameter controls, four-way preview, export."""
from __future__ import annotations

import traceback
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import (QApplication, QCheckBox, QFileDialog,
                               QFrame, QGridLayout, QGroupBox, QHBoxLayout,
                               QLabel, QMainWindow, QMessageBox, QProgressDialog,
                               QPushButton, QSlider, QSpinBox, QSplitter,
                               QStatusBar, QVBoxLayout, QWidget)

import analysis
import canvas
import chart
import frameio
import metrics as metrics_mod
import sample_common as C

APP_TITLE = "时域降噪预览 · Temporal Denoise Preview"


def _dark_palette() -> QPalette:
    pal = QPalette()
    pal.setColor(QPalette.Window, QColor("#141413"))
    pal.setColor(QPalette.WindowText, QColor("#f0efec"))
    pal.setColor(QPalette.Base, QColor("#1a1a19"))
    pal.setColor(QPalette.AlternateBase, QColor("#222220"))
    pal.setColor(QPalette.Text, QColor("#f0efec"))
    pal.setColor(QPalette.Button, QColor("#26261f"))
    pal.setColor(QPalette.ButtonText, QColor("#f0efec"))
    pal.setColor(QPalette.Highlight, QColor("#2a78d6"))
    pal.setColor(QPalette.HighlightedText, QColor("#ffffff"))
    pal.setColor(QPalette.ToolTipBase, QColor("#1a1a19"))
    pal.setColor(QPalette.ToolTipText, QColor("#f0efec"))
    pal.setColor(QPalette.Disabled, QPalette.Text, QColor("#6d6c65"))
    pal.setColor(QPalette.Disabled, QPalette.ButtonText, QColor("#6d6c65"))
    return pal


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_TITLE)
        self.resize(1440, 940)

        self.bundle: dict | None = None
        self.shots: list[analysis.Shot] = []
        self.cuts: list[int] = []
        self.cache: metrics_mod.MetricsCache | None = None
        self.clip_metrics: metrics_mod.ClipMetrics | None = None
        self.result: analysis.Result | None = None
        self.frame = 0
        self.radius = analysis.DEFAULT_RADIUS
        self.threshold = 26.0
        self.playing = False
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._advance)
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(60)
        self._debounce.timeout.connect(self._refresh_metrics_async)

        self._build_ui()
        self._apply_style()
        self.statusBar().showMessage("就绪 - 点击『生成/载入样例』开始")

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(10, 8, 10, 8)
        root.setSpacing(8)

        root.addWidget(self._build_toolbar())

        panes = QSplitter(Qt.Horizontal)
        panes.addWidget(self._build_viewer())
        panes.addWidget(self._build_side_panel())
        panes.setStretchFactor(0, 4)
        panes.setStretchFactor(1, 2)
        panes.setChildrenCollapsible(False)
        root.addWidget(panes, 1)

        root.addWidget(self._build_timeline())
        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())

    def _build_toolbar(self) -> QWidget:
        box = QWidget()
        lay = QGridLayout(box)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setHorizontalSpacing(8)
        lay.setVerticalSpacing(4)

        self.btn_generate = QPushButton("生成样例")
        self.btn_generate.setToolTip("在 samples/ 下生成静止纹理 + 移动小物体 + 硬切 + 干净参考")
        self.btn_generate.clicked.connect(self.on_generate)

        self.btn_load = QPushButton("载入样例")
        self.btn_load.clicked.connect(self.on_load)

        self.radius_spin = QSpinBox()
        self.radius_spin.setRange(0, analysis.MAX_RADIUS)
        self.radius_spin.setValue(self.radius)
        self.radius_spin.setPrefix("邻帧半径 ±")
        self.radius_spin.setToolTip(
            "时间窗口 = [帧-半径, 帧+半径]，只在本镜头内取帧；\n"
            "可用帧数 < 3 时按规则直通（不滤波）")
        self.radius_spin.valueChanged.connect(self.on_radius)

        self.thr_slider = QSlider(Qt.Horizontal)
        self.thr_slider.setRange(6, 90)
        self.thr_slider.setValue(int(self.threshold))
        self.thr_slider.setToolTip("运动判定阈值：越大越激进地做时域平均（尾迹更多）")
        self.thr_slider.valueChanged.connect(self.on_threshold)
        self.thr_label = QLabel(f"运动阈值 {int(self.threshold)}")
        self.thr_label.setMinimumWidth(96)

        self.chk_mask = QCheckBox("运动区域描边")
        self.chk_mask.setChecked(True)
        self.chk_mask.toggled.connect(lambda _: self._render())
        self.chk_trail = QCheckBox("运动尾迹点")
        self.chk_trail.setChecked(True)
        self.chk_trail.toggled.connect(lambda _: self._render())
        self.chk_overlay = QCheckBox("处理范围条")
        self.chk_overlay.setChecked(True)
        self.chk_overlay.toggled.connect(lambda _: self._render())

        self.btn_play = QPushButton("播放")
        self.btn_play.setCheckable(True)
        self.btn_play.toggled.connect(self.on_play)

        self.btn_export = QPushButton("导出…")
        self.btn_export.clicked.connect(self.on_export)
        self.btn_export.setEnabled(False)

        lay.addWidget(self.btn_generate, 0, 0)
        lay.addWidget(self.btn_load, 0, 1)
        lay.addWidget(self.radius_spin, 0, 2)
        lay.addWidget(self.thr_label, 0, 3)
        lay.addWidget(self.thr_slider, 0, 4)
        lay.addWidget(self.btn_play, 0, 5)
        lay.addWidget(self.btn_export, 0, 6)
        lay.addWidget(self.chk_mask, 1, 0, 1, 2)
        lay.addWidget(self.chk_trail, 1, 2, 1, 2)
        lay.addWidget(self.chk_overlay, 1, 4, 1, 2)
        lay.setColumnStretch(4, 1)
        return box

    def _build_viewer(self) -> QWidget:
        box = QGroupBox("预览视图")
        lay = QGridLayout(box)
        lay.setContentsMargins(8, 14, 8, 8)
        lay.setSpacing(6)
        self.view_raw = canvas.Canvas("原始噪点帧")
        self.view_mean = canvas.Canvas("直接平均")
        self.view_atten = canvas.Canvas("运动区域减弱")
        self.view_ref = canvas.Canvas("干净参考")
        lay.addWidget(self.view_raw, 0, 0)
        lay.addWidget(self.view_mean, 0, 1)
        lay.addWidget(self.view_atten, 1, 0)
        lay.addWidget(self.view_ref, 1, 1)
        for col in (0, 1):
            lay.setColumnStretch(col, 1)
        for row in (0, 1):
            lay.setRowStretch(row, 1)
        return box

    def _build_side_panel(self) -> QWidget:
        box = QWidget()
        lay = QVBoxLayout(box)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)

        info = QGroupBox("镜头与窗口")
        grid = QGridLayout(info)
        grid.setContentsMargins(8, 18, 8, 8)
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(6)
        self.lbl_shot = QLabel("-")
        self.lbl_window = QLabel("-")
        self.lbl_window.setWordWrap(True)
        self.lbl_cuts = QLabel("-")
        self.lbl_cuts.setWordWrap(True)
        self.lbl_metric = QLabel("-")
        self.lbl_metric.setWordWrap(True)
        grid.addWidget(QLabel("当前镜头"), 0, 0, Qt.AlignTop)
        grid.addWidget(self.lbl_shot, 0, 1)
        grid.addWidget(QLabel("处理窗口"), 1, 0, Qt.AlignTop)
        grid.addWidget(self.lbl_window, 1, 1)
        grid.addWidget(QLabel("检测到切换"), 2, 0, Qt.AlignTop)
        grid.addWidget(self.lbl_cuts, 2, 1)
        grid.addWidget(QLabel("本帧 RMSE"), 3, 0, Qt.AlignTop)
        grid.addWidget(self.lbl_metric, 3, 1)
        grid.setColumnStretch(1, 1)
        info.setMinimumHeight(168)
        lay.addWidget(info, 0)

        chart_box = QGroupBox("RMSE 对比 (静态区域 · 镜头内 5 帧平滑 · 低者更接近干净参考)")
        chart_lay = QVBoxLayout(chart_box)
        chart_lay.setContentsMargins(2, 18, 2, 2)
        self.chart = chart.MetricChart()
        self.chart.seekRequested.connect(self.set_frame)
        chart_lay.addWidget(self.chart)
        lay.addWidget(chart_box, 1)

        rules = QLabel(
            "规则：\n"
            "· 窗口只在本镜头内，绝不跨切换\n"
            "· 半径 ±R 居中取帧；镜头边界处自动截短\n"
            "· 可用帧 < 3（如开头两帧、R=0）→ 直通并标记\n"
            "· 运动区域减弱：活动像素保留原值，静态区照常平均")
        rules.setWordWrap(True)
        rules.setFrameShape(QFrame.StyledPanel)
        rules.setStyleSheet("color:#c3c2b7; padding:8px; background:#1a1a19;")
        lay.addWidget(rules)
        return box

    def _build_timeline(self) -> QWidget:
        box = QWidget()
        lay = QHBoxLayout(box)
        lay.setContentsMargins(0, 0, 0, 0)
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(0, 0)
        self.slider.valueChanged.connect(self.set_frame)
        self.lbl_frame = QLabel("帧 -/-")
        self.lbl_frame.setMinimumWidth(120)
        self.lbl_time = QLabel("0.00 s")
        self.lbl_time.setMinimumWidth(72)
        lay.addWidget(QLabel("帧"))
        lay.addWidget(self.slider, 1)
        lay.addWidget(self.lbl_frame)
        lay.addWidget(self.lbl_time)
        return box

    def _apply_style(self) -> None:
        self.setPalette(_dark_palette())
        self.setStyleSheet(
            "QGroupBox { border:1px solid #33332f; border-radius:5px; margin-top:8px; }"
            "QGroupBox::title { subcontrol-origin: margin; left:8px; padding:0 4px;"
            " color:#c3c2b7; }"
            "QPushButton { padding:5px 12px; }"
            "QPushButton:disabled { color:#6d6c65; }"
            "QSpinBox { padding:3px 6px; }")

    # -------------------------------------------------------------- state
    def _resolved_sample_dir(self) -> Path:
        return Path(__file__).resolve().parents[1] / "samples"

    def on_generate(self) -> None:
        out = self._resolved_sample_dir()
        dlg = QProgressDialog("正在生成样例…", None, 0, 0, self)
        dlg.setWindowTitle("生成样例")
        dlg.setWindowModality(Qt.WindowModal)
        dlg.show()
        QApplication.processEvents()
        try:
            frameio.write_sample(out)
        except Exception as exc:  # pragma: no cover - GUI path
            dlg.close()
            QMessageBox.critical(self, "生成失败", f"{exc}\n\n{traceback.format_exc(limit=3)}")
            return
        dlg.close()
        self.load_sample(out)

    def on_load(self) -> None:
        start = self._resolved_sample_dir()
        if not (start / C.MANIFEST_NAME).exists():
            QMessageBox.information(self, "提示",
                                    "还没有样例。请先点『生成样例』，或运行 "
                                    "python src/sample_gen.py")
            return
        self.load_sample(start)

    def load_sample(self, root: Path) -> None:
        dlg = QProgressDialog("正在解码样例…", None, 0, 0, self)
        dlg.setWindowModality(Qt.WindowModal)
        dlg.show()
        QApplication.processEvents()
        try:
            self.bundle = frameio.load_bundle(root, scale=0.5)
        except Exception as exc:  # pragma: no cover - GUI path
            dlg.close()
            QMessageBox.critical(self, "载入失败", str(exc))
            return
        dlg.close()

        orig = self.bundle["original"]
        self.cuts = analysis.detect_cuts([orig.read(i) for i in range(len(orig))])
        self.shots = analysis.build_shots(self.cuts, len(orig))
        self.cache = metrics_mod.MetricsCache(self.bundle, self.cuts)
        self.clip_metrics = None

        self.slider.blockSignals(True)
        self.slider.setRange(0, len(orig) - 1)
        self.slider.setValue(min(self.frame, len(orig) - 1))
        self.slider.blockSignals(False)
        self.btn_export.setEnabled(True)
        self.frame = min(self.frame, len(orig) - 1)

        self._refresh_metrics_async()
        self.set_frame(self.frame, force=True)
        self.statusBar().showMessage(
            f"样例: {root}  |  {len(orig)} 帧 @ {orig.fps:.0f} fps  |  "
            f"切换帧 {self.cuts[1:] if len(self.cuts) > 1 else '无'}")

    # ------------------------------------------------------------ controls
    def on_radius(self, value: int) -> None:
        self.radius = int(value)
        self._debounce.start()

    def on_threshold(self, value: int) -> None:
        self.threshold = float(value)
        self.thr_label.setText(f"运动阈值 {value}")
        self._debounce.start()

    def on_play(self, playing: bool) -> None:
        self.playing = playing
        self.btn_play.setText("暂停" if playing else "播放")
        if playing:
            fps = self.bundle["original"].fps if self.bundle else 25.0
            self._timer.start(max(20, int(1000 / max(1.0, fps))))
        else:
            self._timer.stop()

    def _advance(self) -> None:
        if self.bundle is None:
            return
        n = len(self.bundle["original"])
        self.set_frame((self.frame + 1) % n)

    def set_frame(self, value: int, force: bool = False) -> None:
        if self.bundle is None:
            return
        n = len(self.bundle["original"])
        value = max(0, min(n - 1, int(value)))
        if not force and value == self.frame and self.result is not None:
            return
        self.frame = value
        if self.slider.value() != value:
            self.slider.blockSignals(True)
            self.slider.setValue(value)
            self.slider.blockSignals(False)
        self._render()

    # -------------------------------------------------------------- render
    def _current_params(self) -> analysis.Params:
        return analysis.Params(radius=self.radius, motion_threshold=self.threshold)

    def _refresh_metrics_async(self) -> None:
        if self.cache is None:
            return
        dlg = QProgressDialog("正在计算指标…", None, 0, 100, self)
        dlg.setWindowModality(Qt.WindowModal)
        dlg.setMinimumDuration(200)
        try:
            self.clip_metrics = self.cache.get(self._current_params(),
                                               progress=dlg.setValue)
        finally:
            dlg.close()
        self._update_chart()
        self._render()

    def _update_chart(self) -> None:
        if self.clip_metrics is None:
            return
        cm = self.clip_metrics
        series = {
            "raw": ("原始", chart.SERIES_COLORS[0], cm.smooth("raw_static").tolist()),
            "mean": ("直接平均", chart.SERIES_COLORS[1], cm.smooth("mean_static").tolist()),
            "atten": ("运动减弱", chart.SERIES_COLORS[2], cm.smooth("atten_static").tolist()),
        }
        self.chart.set_data(series, cm.cuts,
                            [m.degraded for m in cm.frames], self.frame)

    def _render(self) -> None:
        if self.bundle is None:
            return
        orig = self.bundle["original"]
        clean = self.bundle["clean"]
        params = self._current_params()
        try:
            self.result = analysis.analyze(orig, self.frame, self.shots, params,
                                           want_trail=True)
        except Exception as exc:  # pragma: no cover - GUI path
            self.statusBar().showMessage(f"分析失败: {exc}")
            return
        r = self.result
        shot = analysis.shot_at(self.frame, self.shots)
        raw = orig.read(self.frame)
        ref = clean.read(self.frame)

        sub = f"帧 {self.frame}  (窗口 {r.window.frames[0]}–{r.window.frames[-1]}, " \
              f"{r.window.size} 帧)"
        view_raw = raw
        view_mean = r.mean
        view_atten = r.atten
        if self.chk_overlay.isChecked():
            shot_a = shot.index
            view_raw = canvas.draw_window_overlay(raw, r.window.frames, self.frame,
                                                  shot.start, shot.end)
            view_mean = canvas.draw_window_overlay(r.mean, r.window.frames, self.frame,
                                                   shot.start, shot.end)
            view_atten = canvas.draw_window_overlay(r.atten, r.window.frames, self.frame,
                                                    shot.start, shot.end)
            _ = shot_a
        if self.chk_mask.isChecked() or self.chk_trail.isChecked():
            view_atten = canvas.draw_motion_overlay(
                view_atten, r.motion_mask, r.trail,
                self.chk_mask.isChecked(), self.chk_trail.isChecked())
            view_mean = canvas.draw_motion_overlay(
                view_mean, r.motion_mask, r.trail, self.chk_mask.isChecked(), False)
        if self.frame in self.cuts and self.frame != 0:
            # OpenCV's Hershey fonts are ASCII-only, so the banner stays Latin.
            view_raw = canvas.draw_cut_banner(view_raw, f"CUT -> shot {shot.index + 1}")

        self.view_raw.set_frame(view_raw, sub)
        self.view_mean.set_frame(view_mean, sub)
        self.view_atten.set_frame(view_atten, sub)
        ref_sub = f"帧 {self.frame}  (无噪点/无闪烁)"
        self.view_ref.set_frame(ref, ref_sub)

        self._update_labels(r, shot)
        if self.clip_metrics is not None:
            m = self.clip_metrics.at(self.frame)
            if m is not None:
                self.lbl_metric.setText(
                    f"静态区  原始 {m.raw_static:.1f} · 平均 {m.mean_static:.1f} · "
                    f"减弱 {m.atten_static:.1f}\n"
                    f"运动区  原始 {m.raw_moving:.1f} · 平均 {m.mean_moving:.1f} · "
                    f"减弱 {m.atten_moving:.1f}")
            self.chart.set_current(self.frame)
        self.lbl_frame.setText(f"帧 {self.frame}/{len(orig) - 1}")
        self.lbl_time.setText(f"{self.frame / orig.fps:.2f} s")

    def _update_labels(self, r: analysis.Result, shot: analysis.Shot) -> None:
        self.lbl_shot.setText(
            f"shot {shot.index + 1}  帧 {shot.start}–{shot.end}  ({shot.length} 帧)")
        if r.window.degraded:
            state = "⚠ 可用帧不足 3 → 直通（不滤波）"
        elif r.window.clipped:
            state = "边界截短（不跨镜头，不补帧）"
        else:
            state = "完整窗口"
        self.lbl_window.setText(
            f"半径 ±{self.radius} → 期望 {r.window.desired} 帧\n"
            f"实际 {r.window.frames[0]}–{r.window.frames[-1]} 共 {r.window.size} 帧\n{state}")
        if len(self.cuts) > 1:
            self.lbl_cuts.setText("、".join(
                f"帧 {c} → shot {i + 1}" for i, c in enumerate(self.cuts[1:])))
        else:
            self.lbl_cuts.setText("未检测到切换（按单镜头处理）")

    # -------------------------------------------------------------- export
    def on_export(self) -> None:
        if self.bundle is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出视频（保留帧时间与声音）",
            str(Path.home() / "denoise_export.mp4"), "MP4 (*.mp4)")
        if not path:
            return
        mode, ok = self._ask_mode()
        if not ok:
            return
        dlg = QProgressDialog("正在导出…", "取消", 0, 100, self)
        dlg.setWindowModality(Qt.WindowModal)
        dlg.setMinimumDuration(200)
        dlg.setAutoClose(False)
        dlg.setAutoReset(False)
        cancelled = {"v": False}

        def progress(v: float) -> bool:
            dlg.setValue(int(v * 100))
            QApplication.processEvents()
            if dlg.wasCanceled():
                cancelled["v"] = True
                return False
            return True

        try:
            out = frameio.export_video(self.bundle, self.shots, self._current_params(),
                                       mode, Path(path), progress=progress)
        except frameio.SequenceError as exc:
            dlg.close()
            if str(exc) == "export cancelled":
                self.statusBar().showMessage("导出已取消")
            else:
                QMessageBox.critical(self, "导出失败", str(exc))
            return
        except Exception as exc:  # pragma: no cover - GUI path
            dlg.close()
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        dlg.close()
        self.statusBar().showMessage(f"已导出: {out}")

    def _ask_mode(self) -> tuple[str, bool]:
        box = QMessageBox(self)
        box.setWindowTitle("导出内容")
        box.setText("选择要导出的版本：")
        b_mean = box.addButton("直接平均", QMessageBox.AcceptRole)
        b_atten = box.addButton("运动区域减弱", QMessageBox.AcceptRole)
        b_orig = box.addButton("原始（对照）", QMessageBox.AcceptRole)
        box.addButton("取消", QMessageBox.RejectRole)
        box.exec()
        clicked = box.clickedButton()
        if clicked is b_mean:
            return "mean", True
        if clicked is b_atten:
            return "atten", True
        if clicked is b_orig:
            return "orig", True
        return "", False


def main() -> int:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName("TemporalDenoisePreview")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
