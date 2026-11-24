"""主窗口：参数面板 + 双快门对比 + 时序图/行曲线 + 播放与导出。"""
from __future__ import annotations

import sys
from dataclasses import replace

import numpy as np
from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFrame, QGridLayout,
    QGroupBox, QHBoxLayout, QLabel, QMessageBox, QPushButton, QSpinBox,
    QDoubleSpinBox, QSplitter, QVBoxLayout, QWidget,
)

from ..export import export_clip, verify_export
from ..model import (
    DIRECTION_BOTTOM_UP, DIRECTION_TOP_DOWN, MODE_GLOBAL, MODE_ROLLING,
    Clip, ObjectSpec, SimParams, render_clip,
)
from ..presets import PRESET_FAST, PRESET_FLASH, get_preset
from .timing_diagram import TimingDiagram
from .widgets import ImageViewer, RowPlot


class RenderWorker(QObject):
    done = Signal(object, object)  # (mode, Clip)
    failed = Signal(str)

    def __init__(self, params: SimParams, mode: str):
        super().__init__()
        self._params = params
        self._mode = mode

    def run(self) -> None:
        try:
            clip = render_clip(self._params, self._mode)
            self.done.emit(self._mode, clip)
        except Exception as exc:  # 渲染线程内任何异常回到主线程提示
            self.failed.emit(repr(exc))


def _spin(minimum, maximum, value, step, suffix="", decimals=3) -> QDoubleSpinBox:
    s = QDoubleSpinBox()
    s.setRange(minimum, maximum)
    s.setDecimals(decimals)
    s.setSingleStep(step)
    s.setValue(value)
    if suffix:
        s.setSuffix(suffix)
    s.setKeyboardTracking(False)
    return s


class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("滚动快门 / 全局快门合成模拟")
        self.resize(1280, 860)

        self._clips: dict[str, Clip] = {}
        self._frame = 0
        self._frames = {MODE_GLOBAL: 0, MODE_ROLLING: 0}  # 解锁时各自独立
        self._selected_row = -1
        self._stale = True
        self._stale_reason = "尚未生成"
        self._threads: list[QThread] = []
        self._render_token = 0

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._advance_frame)

        self._build_controls()
        self._build_views()
        self._layout()
        self._connect()
        self._mark_dirty("启动后尚未生成")

    # ------------------------------------------------------------------ UI
    def _build_controls(self) -> None:
        self.panel = QWidget()
        pv = QVBoxLayout(self.panel)

        box_scene = QGroupBox("画面与帧时间")
        g = QGridLayout(box_scene)
        self.sp_w = QSpinBox(); self.sp_w.setRange(8, 1280); self.sp_w.setValue(160)
        self.sp_h = QSpinBox(); self.sp_h.setRange(8, 1024); self.sp_h.setValue(120)
        self.sp_fps = _spin(1.0, 1000.0, 30.0, 1.0, " fps", decimals=4)
        self.sp_n = QSpinBox(); self.sp_n.setRange(1, 600); self.sp_n.setValue(32)
        g.addWidget(QLabel("宽 px"), 0, 0); g.addWidget(self.sp_w, 0, 1)
        g.addWidget(QLabel("高 px"), 0, 2); g.addWidget(self.sp_h, 0, 3)
        g.addWidget(QLabel("帧率"), 1, 0); g.addWidget(self.sp_fps, 1, 1)
        g.addWidget(QLabel("帧数"), 1, 2); g.addWidget(self.sp_n, 1, 3)
        pv.addWidget(box_scene)

        box_shutter = QGroupBox("快门与读出")
        g = QGridLayout(box_shutter)
        self.cb_dir = QComboBox()
        self.cb_dir.addItem("上→下", DIRECTION_TOP_DOWN)
        self.cb_dir.addItem("下→上", DIRECTION_BOTTOM_UP)
        self.sp_readout = _spin(0.0, 2.0, 0.030, 0.001, " s", decimals=6)
        self.sp_exposure = _spin(0.0, 2.0, 0.020, 0.001, " s", decimals=6)
        self.sp_ambient = _spin(0.0, 1.0, 0.05, 0.01, decimals=3)
        g.addWidget(QLabel("读出方向"), 0, 0); g.addWidget(self.cb_dir, 0, 1)
        g.addWidget(QLabel("总读出时间 R"), 1, 0)
        g.addWidget(self.sp_readout, 1, 1)
        g.addWidget(QLabel("曝光时间 E"), 2, 0)
        g.addWidget(self.sp_exposure, 2, 1)
        g.addWidget(QLabel("背景亮度"), 3, 0)
        g.addWidget(self.sp_ambient, 3, 1)
        self.lbl_warn = QLabel("")
        self.lbl_warn.setWordWrap(True)
        self.lbl_warn.setStyleSheet("color: #e0a040;")
        g.addWidget(self.lbl_warn, 4, 0, 1, 4)
        pv.addWidget(box_shutter)

        box_flash = QGroupBox("短闪光")
        g = QGridLayout(box_flash)
        self.ck_flash = QCheckBox("启用闪光")
        self.sp_flash_t = _spin(0.0, 60.0, 0.410, 0.001, " s", decimals=6)
        self.sp_flash_d = _spin(0.0001, 1.0, 0.003, 0.0005, " s", decimals=6)
        self.sp_flash_i = _spin(0.0, 1.0, 0.85, 0.05, decimals=2)
        g.addWidget(self.ck_flash, 0, 0, 1, 2)
        g.addWidget(QLabel("开始时刻"), 1, 0); g.addWidget(self.sp_flash_t, 1, 1)
        g.addWidget(QLabel("持续时长"), 2, 0); g.addWidget(self.sp_flash_d, 2, 1)
        g.addWidget(QLabel("强度"), 3, 0); g.addWidget(self.sp_flash_i, 3, 1)
        pv.addWidget(box_flash)

        self.object_boxes = []
        for idx, default in enumerate(self._default_object_params()):
            ob = QGroupBox(f"运动物体 {idx + 1}")
            g = QGridLayout(ob)
            sp_x0 = _spin(-2000.0, 4000.0, default.x0, 5.0, " px", decimals=3)
            sp_v = _spin(-2000.0, 2000.0, default.velocity, 10.0, " px/s",
                         decimals=3)
            sp_w = _spin(1.0, 1280.0, default.width, 1.0, " px", decimals=3)
            sp_y0 = QSpinBox(); sp_y0.setRange(0, 1023); sp_y0.setValue(default.y0)
            sp_y1 = QSpinBox(); sp_y1.setRange(1, 1024); sp_y1.setValue(default.y1)
            g.addWidget(QLabel("初始 x0"), 0, 0); g.addWidget(sp_x0, 0, 1)
            g.addWidget(QLabel("速度 v"), 1, 0); g.addWidget(sp_v, 1, 1)
            g.addWidget(QLabel("宽度"), 2, 0); g.addWidget(sp_w, 2, 1)
            g.addWidget(QLabel("行起 y0"), 3, 0); g.addWidget(sp_y0, 3, 1)
            g.addWidget(QLabel("行止 y1"), 4, 0); g.addWidget(sp_y1, 4, 1)
            self.object_boxes.append((sp_x0, sp_v, sp_w, sp_y0, sp_y1, default))
            pv.addWidget(ob)

        box_btn = QGroupBox("实验与操作")
        v = QVBoxLayout(box_btn)
        self.btn_render = QPushButton("按当前参数生成两组短片")
        self.btn_fast = QPushButton("内置实验1：快移")
        self.btn_flash = QPushButton("内置实验2：短闪光")
        self.btn_export_g = QPushButton("导出全局快门短片…")
        self.btn_export_r = QPushButton("导出滚动快门短片…")
        for b in (self.btn_render, self.btn_fast, self.btn_flash,
                  self.btn_export_g, self.btn_export_r):
            v.addWidget(b)
        self.lbl_sig = QLabel("当前参数指纹：（未生成）")
        self.lbl_sig.setWordWrap(True)
        v.addWidget(self.lbl_sig)
        pv.addWidget(box_btn)
        pv.addStretch(1)

    def _build_views(self) -> None:
        self.viewer_g = ImageViewer("全局快门（统一曝光）")
        self.viewer_r = ImageViewer("滚动快门（逐行读出）")
        self.timing_g = TimingDiagram()
        self.timing_r = TimingDiagram()
        self.plot_g = RowPlot()
        self.plot_r = RowPlot()

        bar = QWidget()
        h = QHBoxLayout(bar)
        self.btn_prev = QPushButton("◀ 上一帧")
        self.btn_play = QPushButton("播放")
        self.btn_next = QPushButton("下一帧 ▶")
        self.ck_sync = QCheckBox("锁定同一时刻对比")
        self.ck_sync.setChecked(True)
        self.sp_frame = QSpinBox(); self.sp_frame.setRange(0, 0)
        self.lbl_frame = QLabel("帧 -/-")
        self.lbl_row = QLabel("未选择行（在画面或时序图上点击选择）")
        for w in (self.btn_prev, self.btn_play, self.btn_next, self.ck_sync,
                  self.sp_frame, self.lbl_frame, self.lbl_row):
            h.addWidget(w)
        h.addStretch(1)
        self.play_bar = bar

    def _layout(self) -> None:
        split = QSplitter(Qt.Orientation.Horizontal)
        split.addWidget(self.panel)

        center = QWidget()
        cv = QVBoxLayout(center)
        views = QSplitter(Qt.Orientation.Horizontal)
        views.addWidget(self.viewer_g)
        views.addWidget(self.viewer_r)
        timing = QSplitter(Qt.Orientation.Horizontal)
        timing.addWidget(self.timing_g)
        timing.addWidget(self.timing_r)
        plots = QSplitter(Qt.Orientation.Horizontal)
        plots.addWidget(self.plot_g)
        plots.addWidget(self.plot_r)
        vsplit = QSplitter(Qt.Orientation.Vertical)
        vsplit.addWidget(views)
        vsplit.addWidget(timing)
        vsplit.addWidget(plots)
        vsplit.setSizes([360, 240, 240])
        cv.addWidget(vsplit, 1)
        cv.addWidget(self.play_bar)
        split.addWidget(center)
        split.setSizes([300, 980])

        outer = QHBoxLayout(self)
        outer.addWidget(split)

    def _connect(self) -> None:
        dirty_widgets = [
            self.sp_w, self.sp_h, self.sp_fps, self.sp_n, self.cb_dir,
            self.sp_readout, self.sp_exposure, self.sp_ambient,
            self.ck_flash, self.sp_flash_t, self.sp_flash_d, self.sp_flash_i,
        ]
        for boxes in self.object_boxes:
            dirty_widgets.extend(boxes[:5])
        for w in dirty_widgets:
            if isinstance(w, QSpinBox):
                w.valueChanged.connect(self._on_param_changed)
            elif isinstance(w, QDoubleSpinBox):
                w.valueChanged.connect(self._on_param_changed)
            elif isinstance(w, QComboBox):
                w.currentIndexChanged.connect(self._on_param_changed)
            elif isinstance(w, QCheckBox):
                w.toggled.connect(self._on_param_changed)
        self.sp_w.valueChanged.connect(self._update_warnings)
        self.sp_h.valueChanged.connect(self._update_warnings)
        self.sp_fps.valueChanged.connect(self._update_warnings)
        self.sp_readout.valueChanged.connect(self._update_warnings)
        self.sp_exposure.valueChanged.connect(self._update_warnings)

        self.btn_render.clicked.connect(self.render_current)
        self.btn_fast.clicked.connect(lambda: self._load_preset(PRESET_FAST))
        self.btn_flash.clicked.connect(lambda: self._load_preset(PRESET_FLASH))
        self.btn_export_g.clicked.connect(lambda: self._export(MODE_GLOBAL))
        self.btn_export_r.clicked.connect(lambda: self._export(MODE_ROLLING))
        self.btn_prev.clicked.connect(lambda: self._step_frame(-1))
        self.btn_next.clicked.connect(lambda: self._step_frame(1))
        self.btn_play.clicked.connect(self._toggle_play)
        self.ck_sync.toggled.connect(self._on_sync_toggled)
        self.sp_frame.valueChanged.connect(self._jump_to_frame)
        for viewer, timing, plot in (
            (self.viewer_g, self.timing_g, self.plot_g),
            (self.viewer_r, self.timing_r, self.plot_r),
        ):
            viewer.clicked.connect(self._select_row)
            timing.rowSelected.connect(self._select_row)

    @staticmethod
    def _default_object_params() -> tuple[ObjectSpec, ...]:
        from ..model import SimParams
        return SimParams().objects

    # ------------------------------------------------------------- 参数
    def read_params(self) -> SimParams:
        objs = []
        for sp_x0, sp_v, sp_w, sp_y0, sp_y1, default in self.object_boxes:
            y0, y1 = sorted((sp_y0.value(), sp_y1.value()))
            objs.append(ObjectSpec(default.name, sp_x0.value(), sp_v.value(),
                                   sp_w.value(), y0, y1, default.color))
        return SimParams(
            width=self.sp_w.value(),
            height=self.sp_h.value(),
            fps=self.sp_fps.value(),
            n_frames=self.sp_n.value(),
            readout_direction=self.cb_dir.currentData(),
            total_readout=self.sp_readout.value(),
            exposure=self.sp_exposure.value(),
            ambient=self.sp_ambient.value(),
            flash_enabled=self.ck_flash.isChecked(),
            flash_start=self.sp_flash_t.value(),
            flash_duration=self.sp_flash_d.value(),
            flash_intensity=self.sp_flash_i.value(),
            objects=tuple(objs),
        )

    def apply_params(self, params: SimParams) -> None:
        """把一组参数写回控件（加载预设时使用）。"""
        blockers = [self.sp_w, self.sp_h, self.sp_fps, self.sp_n, self.cb_dir,
                    self.sp_readout, self.sp_exposure, self.sp_ambient,
                    self.ck_flash, self.sp_flash_t, self.sp_flash_d,
                    self.sp_flash_i]
        for w in blockers:
            w.blockSignals(True)
        self.sp_w.setValue(params.width)
        self.sp_h.setValue(params.height)
        self.sp_fps.setValue(params.fps)
        self.sp_n.setValue(params.n_frames)
        self.cb_dir.setCurrentIndex(
            0 if params.readout_direction == DIRECTION_TOP_DOWN else 1)
        self.sp_readout.setValue(params.total_readout)
        self.sp_exposure.setValue(params.exposure)
        self.sp_ambient.setValue(params.ambient)
        self.ck_flash.setChecked(params.flash_enabled)
        self.sp_flash_t.setValue(params.flash_start)
        self.sp_flash_d.setValue(params.flash_duration)
        self.sp_flash_i.setValue(params.flash_intensity)
        for boxes, obj in zip(self.object_boxes, params.objects):
            for w in boxes[:5]:
                w.blockSignals(True)
            boxes[0].setValue(obj.x0)
            boxes[1].setValue(obj.velocity)
            boxes[2].setValue(obj.width)
            boxes[3].setValue(obj.y0)
            boxes[4].setValue(obj.y1)
        for w in blockers:
            w.blockSignals(False)
        for boxes in self.object_boxes:
            for w in boxes[:5]:
                w.blockSignals(False)
        self._update_warnings()

    def _on_param_changed(self, *_args) -> None:
        self._update_warnings()
        self._mark_dirty("参数控件已改动，点击“生成”刷新")

    def _update_warnings(self) -> None:
        try:
            _, warnings = self.read_params().validate()
        except Exception:
            return
        self.lbl_warn.setText("⚠ " + "；".join(warnings) if warnings else "")

    def _mark_dirty(self, reason: str) -> None:
        self._stale = True
        self._stale_reason = reason
        self._timer.stop()
        self.btn_play.setText("播放")
        self._refresh_views()

    # ------------------------------------------------------------- 渲染
    def render_current(self) -> None:
        params = self.read_params()
        errors, _ = params.validate()
        if errors:
            QMessageBox.warning(self, "参数无效", "\n".join(errors))
            return
        self._render_token += 1
        token = self._render_token
        self.btn_render.setEnabled(False)
        self.btn_render.setText("渲染中…")
        self._mark_dirty("正在按新参数重新生成")
        for mode in (MODE_GLOBAL, MODE_ROLLING):
            thread = QThread(self)
            worker = RenderWorker(params, mode)
            worker.moveToThread(thread)
            thread.started.connect(worker.run)
            worker.done.connect(
                lambda m, clip, t=token: self._on_rendered(t, m, clip))
            worker.failed.connect(self._on_render_failed)
            worker.done.connect(thread.quit)
            worker.failed.connect(thread.quit)
            thread.finished.connect(worker.deleteLater)
            thread.finished.connect(thread.deleteLater)
            self._threads = [t for t in self._threads if t.isRunning()]
            self._threads.append(thread)
            thread.start()

    def _on_rendered(self, token: int, mode: str, clip: Clip) -> None:
        if token != self._render_token:
            return  # 已有更新的一次渲染，丢弃过期结果
        self._clips[mode] = clip
        if len(self._clips) == 2 and all(
                c.signature == clip.signature for c in self._clips.values()):
            n = clip.n_frames
            self.sp_frame.blockSignals(True)
            self.sp_frame.setRange(0, n - 1)
            self.sp_frame.blockSignals(False)
            self._frame = min(self._frame, n - 1)
            self._frames = {MODE_GLOBAL: self._frame, MODE_ROLLING: self._frame}
            self._selected_row = min(self._selected_row,
                                     clip.params.height - 1)
            self._stale = False
            self._stale_reason = ""
            self.lbl_sig.setText(f"当前参数指纹：{clip.signature}")
            self.btn_render.setEnabled(True)
            self.btn_render.setText("按当前参数生成两组短片")
            self._refresh_views()

    def _on_render_failed(self, msg: str) -> None:
        self.btn_render.setEnabled(True)
        self.btn_render.setText("按当前参数生成两组短片")
        QMessageBox.critical(self, "渲染失败", msg)

    # ------------------------------------------------------------- 显示
    def _refresh_views(self) -> None:
        for mode, viewer, timing, plot in (
            (MODE_GLOBAL, self.viewer_g, self.timing_g, self.plot_g),
            (MODE_ROLLING, self.viewer_r, self.timing_r, self.plot_r),
        ):
            clip = self._clips.get(mode)
            fi = self._frame if self.ck_sync.isChecked() else self._frames[mode]
            if clip is None or fi >= clip.n_frames:
                viewer.clear_frame(self._stale_reason or "尚未生成")
                continue
            viewer.show_frame(clip, fi, self._stale, self._stale_reason)
            timing.set_frame(clip, fi, self._selected_row)
            plot.set_frame(clip, fi, self._selected_row)
        if self._clips:
            any_clip = next(iter(self._clips.values()))
            prm = any_clip.params
            if self.ck_sync.isChecked():
                frame_txt = f"帧 {self._frame}/{any_clip.n_frames - 1}"
            else:
                frame_txt = "帧 全局{} / 滚动{}".format(
                    self._frames[MODE_GLOBAL], self._frames[MODE_ROLLING])
            self.lbl_frame.setText(
                f"{frame_txt}  t={self._frame / prm.fps:.3f}s")
            if 0 <= self._selected_row < prm.height:
                self._update_row_label()
            else:
                self.lbl_row.setText("未选择行（在画面或时序图上点击选择）")

    def _update_row_label(self) -> None:
        r = self._selected_row
        if r < 0:
            return
        parts = []
        for mode, name in ((MODE_GLOBAL, "全局"), (MODE_ROLLING, "滚动")):
            clip = self._clips.get(mode)
            if clip is None:
                continue
            fi = self._frame if self.ck_sync.isChecked() else self._frames[mode]
            a, b = clip.windows[fi, r]
            parts.append(
                f"{name}: 曝光{a * 1000:.2f}~{b * 1000:.2f}ms"
                f" 读出{clip.readout_starts[fi, r] * 1000:.2f}ms"
                f" 闪光覆盖{clip.flash_overlap[fi, r]:.2f}")
        self.lbl_row.setText(f"行 {r}： " + " ｜ ".join(parts))

    def _select_row(self, row: int) -> None:
        self._selected_row = row
        for timing, plot in ((self.timing_g, self.plot_g),
                             (self.timing_r, self.plot_r)):
            timing.set_selected_row(row)
            plot.set_selected_row(row)
        self._update_row_label()

    # ------------------------------------------------------------- 播放
    def _step_frame(self, delta: int) -> None:
        if not self._clips:
            return
        n = next(iter(self._clips.values())).n_frames
        if self.ck_sync.isChecked():
            self._frame = int(np.clip(self._frame + delta, 0, n - 1))
            self._frames = {MODE_GLOBAL: self._frame, MODE_ROLLING: self._frame}
        else:
            for mode in (MODE_GLOBAL, MODE_ROLLING):
                self._frames[mode] = int(
                    np.clip(self._frames[mode] + delta, 0, n - 1))
            self._frame = self._frames[MODE_ROLLING]
        self.sp_frame.blockSignals(True)
        self.sp_frame.setValue(self._frame)
        self.sp_frame.blockSignals(False)
        self._refresh_views()

    def _jump_to_frame(self, value: int) -> None:
        self._frame = value
        if self.ck_sync.isChecked():
            self._frames = {MODE_GLOBAL: value, MODE_ROLLING: value}
        else:
            # 帧号输入框跟随滚动侧基准，只更新滚动侧；全局侧保持独立
            self._frames[MODE_ROLLING] = value
        self._refresh_views()

    def _on_sync_toggled(self, checked: bool) -> None:
        if checked:  # 重新锁定：两边对齐到当前滚动侧帧时刻
            self._frame = self._frames[MODE_ROLLING]
            self._frames = {MODE_GLOBAL: self._frame, MODE_ROLLING: self._frame}
            self.sp_frame.blockSignals(True)
            self.sp_frame.setValue(self._frame)
            self.sp_frame.blockSignals(False)
        self._refresh_views()

    def _advance_frame(self) -> None:
        if not self._clips:
            return
        n = next(iter(self._clips.values())).n_frames
        if self._frame >= n - 1:
            self._timer.stop()
            self.btn_play.setText("播放")
            return
        self._step_frame(1)

    def _toggle_play(self) -> None:
        if self._timer.isActive():
            self._timer.stop()
            self.btn_play.setText("播放")
        elif self._clips and not self._stale:
            self._timer.start(int(1000 /
                                  next(iter(self._clips.values())).params.fps))
            self.btn_play.setText("暂停")

    # ------------------------------------------------------------- 预设/导出
    def _load_preset(self, key: str) -> None:
        self.apply_params(get_preset(key))
        self.render_current()

    def _export(self, mode: str) -> None:
        clip = self._clips.get(mode)
        if clip is None or self._stale:
            QMessageBox.information(
                self, "无法导出",
                "当前显示的是旧帧或尚未生成，请先点击“按当前参数生成两组短片”。")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出短片", f"{mode}_clip.zip", "Zip 导出包 (*.zip)")
        if not path:
            return
        export_clip(clip, path)
        report = verify_export(path)
        lines = [f"已导出：{path}",
                 f"模式：{mode}，指纹：{clip.signature}",
                 f"核对结果：{'全部通过' if report['ok'] else '存在失败项'}"]
        for c in report["checks"]:
            lines.append(f"  [{'OK' if c['ok'] else 'FAIL'}] {c['name']}"
                         + (f"（{c['detail']}）" if c["detail"] else ""))
        box = QMessageBox(self)
        box.setWindowTitle("导出并自检")
        box.setText("\n".join(lines))
        box.exec()


def run() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
