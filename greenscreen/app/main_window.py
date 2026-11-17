"""主窗口：三画面同步预览、实时调参、前后对比、导出。

三个画面（原始 / 抠像前景 / 合成结果）由同一次 :meth:`_render` 调用
从同一帧渲染，因此播放、暂停、拖动时间轴、重新播放时永远处于同一时刻。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QPixmap
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QColorDialog, QFileDialog, QFrame, QGridLayout,
    QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox, QProgressBar,
    QPushButton, QSlider, QStatusBar, QVBoxLayout, QWidget, QSizePolicy,
)

from .. import GreenScreenError
from ..keying import KeyingParams, process_frame
from ..media import VideoReader, load_image, probe_video
from .export_worker import ExportWorker
from .imaging import bgr_to_qpixmap


class ImageView(QLabel):
    """可点击取色的画面控件，点击时发出帧内坐标。"""

    def __init__(self, title: str, pick_callback=None):
        super().__init__()
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(320, 180)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setStyleSheet("background:#111; color:#888; border:1px solid #333;")
        self.setText(f"{title}\n（未加载素材）")
        self.title = title
        self._pick_callback = pick_callback
        self._frame_shape: tuple[int, int] | None = None
        self._pixmap = QPixmap()

    def set_frame(self, frame_bgr: np.ndarray) -> None:
        self._frame_shape = frame_bgr.shape[:2]  # (h, w)
        self._pixmap = bgr_to_qpixmap(frame_bgr)
        self._rescale()

    def _rescale(self) -> None:
        if not self._pixmap.isNull():
            self.setPixmap(
                self._pixmap.scaled(
                    self.size(),
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation,
                )
            )

    def resizeEvent(self, event) -> None:
        self._rescale()
        super().resizeEvent(event)

    def mousePressEvent(self, event) -> None:
        if self._pick_callback and self._frame_shape and not self._pixmap.isNull():
            # 把控件坐标换算回原始帧坐标（考虑等比缩放留边）
            fh, fw = self._frame_shape
            scaled = self._pixmap.scaled(
                self.size(), Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            off_x = (self.width() - scaled.width()) / 2
            off_y = (self.height() - scaled.height()) / 2
            fx = int((event.position().x() - off_x) / scaled.width() * fw)
            fy = int((event.position().y() - off_y) / scaled.height() * fh)
            if 0 <= fx < fw and 0 <= fy < fh:
                self._pick_callback(fx, fy)
        super().mousePressEvent(event)


class SliderRow(QWidget):
    """0~1 浮点参数滑块行。"""

    def __init__(self, label: str, value: float, on_change):
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.name = QLabel(label)
        self.name.setMinimumWidth(72)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 1000)
        self.slider.setValue(int(round(value * 1000)))
        self.value_label = QLabel(f"{value:.2f}")
        self.value_label.setMinimumWidth(36)
        lay.addWidget(self.name)
        lay.addWidget(self.slider, 1)
        lay.addWidget(self.value_label)
        self._on_change = on_change
        self.slider.valueChanged.connect(self._changed)

    def _changed(self, v: int) -> None:
        fv = v / 1000.0
        self.value_label.setText(f"{fv:.2f}")
        self._on_change(fv)

    def set_value(self, value: float) -> None:
        self.slider.setValue(int(round(value * 1000)))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("绿幕抠像本地合成预览工具")
        self.resize(1320, 860)

        self.reader: VideoReader | None = None
        self.background: np.ndarray | None = None
        self.fg_path: str | None = None
        self.bg_path: str | None = None
        self.params = KeyingParams()
        self.current_index = 0
        self.playing = False
        self.eyedropper = False
        # 对比开关：临时绕过某项处理，不改动正式参数
        self.compare_no_despill = False
        self.compare_no_protection = False
        self._last_frame: np.ndarray | None = None
        self.worker: ExportWorker | None = None

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)

        self._build_ui()

    # ---------------- UI 搭建 ----------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # 左：三个画面
        views = QVBoxLayout()
        toolbar = QHBoxLayout()
        self.btn_open_fg = QPushButton("打开前景视频")
        self.btn_open_bg = QPushButton("打开背景图")
        self.btn_gen = QPushButton("生成测试素材")
        for b in (self.btn_open_fg, self.btn_open_bg, self.btn_gen):
            toolbar.addWidget(b)
        toolbar.addStretch(1)
        views.addLayout(toolbar)

        grid = QGridLayout()
        self.view_original = ImageView("原始画面", self._pick_color)
        self.view_foreground = ImageView("去除背景后的前景")
        self.view_composite = ImageView("合成结果")
        grid.addWidget(self.view_original, 0, 0)
        grid.addWidget(self.view_foreground, 0, 1)
        grid.addWidget(self.view_composite, 0, 2)
        for i in range(3):
            grid.setColumnStretch(i, 1)
        views.addLayout(grid, 1)

        # 播放控制
        play_row = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_replay = QPushButton("重新播放")
        self.btn_play.setMinimumWidth(96)
        self.time_slider = QSlider(Qt.Orientation.Horizontal)
        self.time_slider.setRange(0, 0)
        self.time_label = QLabel("00:00.00 / 00:00.00")
        self.frame_label = QLabel("帧 0/0")
        play_row.addWidget(self.btn_play)
        play_row.addWidget(self.btn_replay)
        play_row.addWidget(self.time_slider, 1)
        play_row.addWidget(self.time_label)
        play_row.addWidget(self.frame_label)
        views.addLayout(play_row)
        root.addLayout(views, 3)

        # 右：参数面板
        root.addWidget(self._build_param_panel(), 1)

        self.setStatusBar(QStatusBar())
        self.progress = QProgressBar()
        self.progress.setMaximumWidth(260)
        self.progress.setVisible(False)
        self.statusBar().addPermanentWidget(self.progress)

        self.btn_open_fg.clicked.connect(self._choose_foreground)
        self.btn_open_bg.clicked.connect(self._choose_background)
        self.btn_gen.clicked.connect(self._generate_assets)
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_replay.clicked.connect(self._replay)
        self.time_slider.sliderMoved.connect(self._seek)
        self.time_slider.sliderReleased.connect(
            lambda: self._seek(self.time_slider.value())
        )

    def _build_param_panel(self) -> QWidget:
        panel = QWidget()
        panel.setMaximumWidth(380)
        v = QVBoxLayout(panel)

        # 取色
        key_box = QGroupBox("背景取色")
        kl = QVBoxLayout(key_box)
        key_row = QHBoxLayout()
        self.btn_key_color = QPushButton()
        self.btn_key_color.setFixedSize(64, 32)
        self._update_key_color_button()
        self.btn_eyedrop = QPushButton("在原始画面取色")
        self.btn_eyedrop.setCheckable(True)
        key_row.addWidget(self.btn_key_color)
        key_row.addWidget(self.btn_eyedrop, 1)
        kl.addLayout(key_row)
        self.btn_key_color.clicked.connect(self._choose_key_color_dialog)
        self.btn_eyedrop.toggled.connect(self._toggle_eyedropper)
        v.addWidget(key_box)

        # 颜色范围
        range_box = QGroupBox("背景颜色范围")
        rl = QVBoxLayout(range_box)
        self.sl_hue = SliderRow("色相宽度", self.params.hue_width,
                                lambda x: self._set_param("hue_width", x))
        self.sl_sat = SliderRow("饱和度下限", self.params.sat_min,
                                lambda x: self._set_param("sat_min", x))
        self.sl_val = SliderRow("明度下限", self.params.val_min,
                                lambda x: self._set_param("val_min", x))
        for w in (self.sl_hue, self.sl_sat, self.sl_val):
            rl.addWidget(w)
        v.addWidget(range_box)

        # 边缘
        edge_box = QGroupBox("边缘过渡")
        el = QVBoxLayout(edge_box)
        self.sl_sim = SliderRow("去背景强度", self.params.similarity,
                                lambda x: self._set_param("similarity", x))
        self.sl_smooth = SliderRow("柔和过渡", self.params.smoothness,
                                   lambda x: self._set_param("smoothness", x))
        self.sl_feather = SliderRow("边缘羽化", self.params.edge_feather,
                                    lambda x: self._set_param("edge_feather", x))
        self.sl_choke = SliderRow("收边", self.params.edge_choke,
                                  lambda x: self._set_param("edge_choke", x))
        self.sl_shadow = SliderRow("发丝/暗部保护", self.params.shadow_protect,
                                   lambda x: self._set_param("shadow_protect", x))
        for w in (self.sl_sim, self.sl_smooth, self.sl_feather,
                  self.sl_choke, self.sl_shadow):
            el.addWidget(w)
        v.addWidget(edge_box)

        # 反光与保护
        fix_box = QGroupBox("反光与前景保护")
        fl = QVBoxLayout(fix_box)
        self.cb_despill = QCheckBox("启用绿色反光抑制")
        self.cb_despill.setChecked(self.params.despill_on)
        self.cb_protect = QCheckBox("启用近色前景保护")
        self.cb_protect.setChecked(self.params.protection_on)
        self.cb_despill.toggled.connect(
            lambda on: self._set_param("despill_on", on))
        self.cb_protect.toggled.connect(
            lambda on: self._set_param("protection_on", on))
        fl.addWidget(self.cb_despill)
        fl.addWidget(self.cb_protect)
        self.sl_spill = SliderRow("反光抑制强度", self.params.spill_strength,
                                  lambda x: self._set_param("spill_strength", x))
        self.sl_protect = SliderRow("前景保护强度", self.params.protection,
                                    lambda x: self._set_param("protection", x))
        fl.addWidget(self.sl_spill)
        fl.addWidget(self.sl_protect)
        self.btn_cmp_spill = QPushButton("对比：查看反光处理前")
        self.btn_cmp_spill.setCheckable(True)
        self.btn_cmp_protect = QPushButton("对比：查看保护前")
        self.btn_cmp_protect.setCheckable(True)
        self.btn_cmp_spill.toggled.connect(self._toggle_compare_spill)
        self.btn_cmp_protect.toggled.connect(self._toggle_compare_protect)
        fl.addWidget(self.btn_cmp_spill)
        fl.addWidget(self.btn_cmp_protect)
        v.addWidget(fix_box)

        # 导出
        exp_box = QGroupBox("导出")
        xl = QVBoxLayout(exp_box)
        self.btn_export = QPushButton("按当前设置导出视频")
        xl.addWidget(self.btn_export)
        self.export_hint = QLabel("导出尺寸/帧率/音轨与源视频一致")
        self.export_hint.setWordWrap(True)
        self.export_hint.setStyleSheet("color:#777;")
        xl.addWidget(self.export_hint)
        v.addWidget(exp_box)
        v.addStretch(1)

        self.btn_export.clicked.connect(self._start_export)
        panel.setLayout(v)
        return panel

    # ---------------- 素材加载 ----------------
    def _choose_foreground(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择前景视频", "",
            "视频文件 (*.mp4 *.mov *.mkv *.avi *.m4v *.webm *.mpg *.mpeg)")
        if path:
            self.load_foreground(path)

    def _choose_background(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择静态背景图", "",
            "图片文件 (*.jpg *.jpeg *.png *.bmp *.webp *.tif *.tiff)")
        if path:
            self.load_background(path)

    def _generate_assets(self) -> None:
        from ..generate_test_assets import generate

        out_dir = QFileDialog.getExistingDirectory(
            self, "选择测试素材输出目录", str(Path.cwd()))
        if not out_dir:
            return
        try:
            QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
            paths = generate(out_dir)
        except Exception as exc:
            QApplication.restoreOverrideCursor()
            self._error("生成测试素材失败", str(exc))
            return
        finally:
            QApplication.restoreOverrideCursor()
        self.load_background(str(paths["background"]))
        self.load_foreground(str(paths["video"]))
        self.statusBar().showMessage(f"已生成并加载测试素材：{out_dir}", 8000)

    def load_foreground(self, path: str) -> None:
        try:
            reader = VideoReader(path)
        except GreenScreenError as exc:
            self._error("无法打开前景视频", str(exc))
            return
        if self.reader:
            self.reader.close()
        self.reader = reader
        self.fg_path = path
        self.current_index = 0
        self.time_slider.setRange(0, reader.frame_count - 1)
        self.time_slider.setValue(0)
        self._stop_play()
        self._update_time_labels()
        self.statusBar().showMessage(
            f"前景：{Path(path).name}  {reader.info.width}x{reader.info.height}"
            f"  {reader.fps:.2f}fps  {reader.frame_count}帧"
            f"  {'含音轨' if reader.info.has_audio else '无音轨'}", 10000)
        self._render()

    def load_background(self, path: str) -> None:
        try:
            img = load_image(path)
        except GreenScreenError as exc:
            self._error("无法打开背景图", str(exc))
            return
        self.background = img
        self.bg_path = path
        self.statusBar().showMessage(
            f"背景：{Path(path).name}  {img.shape[1]}x{img.shape[0]}", 10000)
        self._render()

    # ---------------- 参数与取色 ----------------
    def _set_param(self, name: str, value) -> None:
        setattr(self.params, name, value)
        self._schedule_render()

    def _schedule_render(self) -> None:
        # 播放中由定时器逐帧渲染；暂停时立即重绘当前帧
        if not self.playing:
            self._render()

    def _toggle_eyedropper(self, on: bool) -> None:
        self.eyedropper = on
        if on:
            self.view_original.setCursor(Qt.CursorShape.CrossCursor)
            self.statusBar().showMessage("在左侧原始画面上点击要作为背景的颜色", 6000)
        else:
            self.view_original.unsetCursor()

    def _pick_color(self, x: int, y: int) -> None:
        if not self.eyedropper or self._last_frame is None:
            return
        h, w = self._last_frame.shape[:2]
        if not (0 <= x < w and 0 <= y < h):
            return
        b, g, r = (int(v) for v in self._last_frame[y, x])
        self.params.key_bgr = (b, g, r)
        self._update_key_color_button()
        self.eyedropper = False
        self.btn_eyedrop.setChecked(False)
        self.view_original.unsetCursor()
        self._schedule_render()

    def _choose_key_color_dialog(self) -> None:
        b, g, r = self.params.key_bgr
        color = QColorDialog.getColor(QColor(r, g, b), self, "选择背景色")
        if color.isValid():
            self.params.key_bgr = (color.blue(), color.green(), color.red())
            self._update_key_color_button()
            self._schedule_render()

    def _update_key_color_button(self) -> None:
        b, g, r = self.params.key_bgr
        self.btn_key_color.setStyleSheet(
            f"background:rgb({r},{g},{b}); border:1px solid #555;")

    def _toggle_compare_spill(self, on: bool) -> None:
        self.compare_no_despill = on
        self.btn_cmp_spill.setText(
            "对比中：正在显示反光处理前" if on else "对比：查看反光处理前")
        self._schedule_render()

    def _toggle_compare_protect(self, on: bool) -> None:
        self.compare_no_protection = on
        self.btn_cmp_protect.setText(
            "对比中：正在显示保护前" if on else "对比：查看保护前")
        self._schedule_render()

    def _effective_params(self) -> KeyingParams:
        """对比模式下返回临时副本，正式参数不被改动。"""
        if not (self.compare_no_despill or self.compare_no_protection):
            return self.params
        p = KeyingParams.from_dict(self.params.to_dict())
        if self.compare_no_despill:
            p.despill_on = False
        if self.compare_no_protection:
            p.protection_on = False
        return p

    # ---------------- 播放 ----------------
    def _toggle_play(self) -> None:
        if self.reader is None:
            self._warn("请先打开一个前景视频。")
            return
        if self.playing:
            self._stop_play()
        else:
            if self.current_index >= self.reader.frame_count - 1:
                self.current_index = 0  # 播完后再按播放即从头开始
            self.playing = True
            self.btn_play.setText("暂停")
            self.timer.start(max(1, int(1000 / self.reader.fps)))

    def _stop_play(self) -> None:
        self.playing = False
        self.timer.stop()
        self.btn_play.setText("播放")

    def _replay(self) -> None:
        if self.reader is None:
            self._warn("请先打开一个前景视频。")
            return
        self.current_index = 0
        self.time_slider.setValue(0)
        self._update_time_labels()
        self.playing = True
        self.btn_play.setText("暂停")
        self.timer.start(max(1, int(1000 / self.reader.fps)))
        self._render()

    def _seek(self, index: int) -> None:
        if self.reader is None:
            return
        self.current_index = int(np.clip(index, 0, self.reader.frame_count - 1))
        # 程序化跳转（如测试、重新播放）也要同步滑块；用户拖动时
        # setValue 与当前位置相同，不会产生多余信号
        if not self.time_slider.isSliderDown():
            self.time_slider.setValue(self.current_index)
        self._update_time_labels()
        self._render()  # 拖动中也实时渲染，三个画面同步跳到该时刻

    def _tick(self) -> None:
        if self.reader is None:
            self._stop_play()
            return
        if self.current_index >= self.reader.frame_count - 1:
            self._stop_play()
            return
        self.current_index += 1
        if not self.time_slider.isSliderDown():
            self.time_slider.setValue(self.current_index)
        self._update_time_labels()
        self._render()

    def _update_time_labels(self) -> None:
        if self.reader is None:
            return
        fps = self.reader.fps
        cur = self.current_index / fps
        total = (self.reader.frame_count - 1) / fps
        self.time_label.setText(f"{self._fmt(cur)} / {self._fmt(total)}")
        self.frame_label.setText(
            f"帧 {self.current_index + 1}/{self.reader.frame_count}")

    @staticmethod
    def _fmt(sec: float) -> str:
        m = int(sec // 60)
        s = sec - m * 60
        return f"{m:02d}:{s:05.2f}"

    # ---------------- 渲染（三画面同一帧） ----------------
    def _render(self) -> None:
        if self.reader is None:
            return
        try:
            frame = self.reader.read_frame(self.current_index)
        except GreenScreenError as exc:
            self._stop_play()
            self._error("画面读取失败", str(exc))
            return
        if frame is None:
            return
        self._last_frame = frame
        self.view_original.set_frame(frame)

        if self.background is None:
            # 还没选背景：前景和合成位给出明确提示，不假装成功
            placeholder = frame.copy()
            self.view_foreground.set_frame(frame)
            self.view_composite.setText("请打开一张静态背景图\n后显示合成结果")
            self.view_composite.setPixmap(QPixmap())
            return

        try:
            result = process_frame(frame, self.background,
                                   self._effective_params())
        except GreenScreenError as exc:
            self._error("处理失败", str(exc))
            return
        self.view_foreground.set_frame(result["foreground"])
        self.view_composite.set_frame(result["composite"])

    # ---------------- 导出 ----------------
    def _start_export(self) -> None:
        if self.reader is None or self.fg_path is None:
            self._warn("请先打开前景视频。")
            return
        if self.background is None or self.bg_path is None:
            self._warn("请先打开一张静态背景图。")
            return
        default_name = Path(self.fg_path).stem + "_composed.mp4"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出到", str(Path(self.fg_path).with_name(default_name)),
            "MP4 视频 (*.mp4);;MOV 视频 (*.mov);;MKV 视频 (*.mkv);;AVI (*.avi)")
        if not path:
            return

        self.progress.setVisible(True)
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.btn_export.setEnabled(False)
        self.statusBar().showMessage("正在导出……")

        self.worker = ExportWorker(
            self.fg_path, self.bg_path, path,
            KeyingParams.from_dict(self.params.to_dict()))
        self.worker.progress.connect(self._export_progress)
        self.worker.succeeded.connect(lambda r: self._export_done(path, r))
        self.worker.failed.connect(self._export_failed)
        self.worker.start()

    def _export_progress(self, done: int, total: int) -> None:
        self.progress.setRange(0, total)
        self.progress.setValue(done)
        self.statusBar().showMessage(f"正在导出…… {done}/{total} 帧")

    def _export_done(self, path: str, result: dict) -> None:
        self.progress.setVisible(False)
        self.btn_export.setEnabled(True)
        self.statusBar().showMessage(f"导出完成并通过回读校验：{path}", 12000)
        box = QMessageBox(self)
        box.setWindowTitle("导出完成")
        box.setIcon(QMessageBox.Icon.Information)
        box.setText(
            f"导出成功并已回读校验：\n{path}\n\n"
            f"尺寸 {result['width']}x{result['height']}，"
            f"{result['fps']:.2f}fps，"
            f"解码 {result['frames_decoded']}/{result['frames_expected']} 帧，"
            f"音轨：{'保留' if result['has_audio'] else '源无音轨'}。")
        btn_reopen = box.addButton("重新打开核对", QMessageBox.ButtonRole.AcceptRole)
        box.addButton("关闭", QMessageBox.ButtonRole.RejectRole)
        box.exec()
        if box.clickedButton() is btn_reopen:
            # 用系统默认播放器打开，人工核对导出结果
            from PySide6.QtGui import QDesktopServices
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))

    def _export_failed(self, message: str) -> None:
        self.progress.setVisible(False)
        self.btn_export.setEnabled(True)
        self._error("导出失败", message)

    # ---------------- 提示 ----------------
    def _warn(self, text: str) -> None:
        QMessageBox.warning(self, "提示", text)

    def _error(self, title: str, text: str) -> None:
        QMessageBox.critical(self, title, text)
        self.statusBar().showMessage(f"{title}：{text}", 10000)


def run() -> int:
    import sys

    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
