"""视频帧、源坐标矩形和字幕框的缩放预览。"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer, QVideoSink
from PySide6.QtWidgets import QWidget

from .coordinates import fitted_video_rect, widget_to_source
from .layout import render_subtitle
from .media import extract_frame
from .model import Cue, Obstacle, Placement, Rect, obstacles_at
from .planner import PlacementStore


class VideoView(QWidget):
    timeChanged = Signal(float)
    rectangleDrawn = Signal(object)
    obstacleSelected = Signal(str)
    obstacleGeometryChanged = Signal(str, object)
    manualPositionCommitted = Signal(str, float, float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(640, 360)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setStyleSheet("background:#111827;")

        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setAudioOutput(self.audio)
        self.sink = QVideoSink(self)
        self.player.setVideoSink(self.sink)
        self.sink.videoFrameChanged.connect(self._on_frame)
        self.player.positionChanged.connect(self._on_position_ms)
        self.player.playbackStateChanged.connect(self._on_playback_state_changed)

        self.media_path: str | None = None
        self._still_frame_path = Path(tempfile.gettempdir()) / (
            f"subtitle_dodge_still_{os.getpid()}.png"
        )
        self.still_timer = QTimer(self)
        self.still_timer.setSingleShot(True)
        self.still_timer.setInterval(90)
        self.still_timer.timeout.connect(self._extract_still_frame)

        self.frame_image = None
        self.video_width = 1280
        self.video_height = 720
        self.time = 0.0
        self.duration = 0.0

        self.cues: list[Cue] = []
        self.obstacles: list[Obstacle] = []
        self.placements: dict[str, Placement] = {}
        self.store: PlacementStore | None = None
        self.current_cue_id: str | None = None
        self.selected_obstacle_id: str | None = None
        self.interaction_mode = "obstacle"  # obstacle | manual
        self.show_candidates = False

        self._draft: Rect | None = None
        self._draft_start: tuple[float, float] | None = None
        self._drag_obstacle: tuple[str, float, float] | None = None
        self._drag_manual: tuple[str, float, float] | None = None
        self._manual_drag_pos: Rect | None = None

    def set_video_size(self, w: int, h: int) -> None:
        self.video_width = max(1, int(w))
        self.video_height = max(1, int(h))
        self.update()

    def set_scene(self, store: PlacementStore) -> None:
        self.store = store
        self.cues = store.cues
        self.obstacles = store.obstacles
        self.placements = store.placements
        self.update()

    def load_media(self, path: str | Path) -> None:
        self.media_path = str(Path(path).resolve())
        self.player.setSource(QUrl.fromLocalFile(self.media_path))
        # 先给一帧 ffmpeg 海报，避免 Qt 后端异步加载期间预览全黑。
        self._extract_still_frame(self.time)

    def play(self) -> None:
        self.still_timer.stop()
        # 一旦真正播放，就从“审查某一条”的 pin 模式切回按时间显示。
        self.current_cue_id = None
        self.player.play()

    def pause(self) -> None:
        self.player.pause()

    def toggle_play(self) -> None:
        if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.pause()
        else:
            self.play()

    def seek(self, seconds: float) -> None:
        seconds = max(0.0, seconds)
        self.time = seconds
        self.player.setPosition(int(seconds * 1000))
        self.update()
        self.timeChanged.emit(seconds)
        if self.player.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
            self.still_timer.start()

    def _on_playback_state_changed(self, state) -> None:
        self.update()
        if state == QMediaPlayer.PlaybackState.PausedState:
            self.still_timer.start()

    def _extract_still_frame(self, t: float | None = None) -> None:
        if not self.media_path:
            return
        try:
            extract_frame(
                self.media_path,
                self.time if t is None else t,
                self._still_frame_path,
            )
            image = self._on_frame_image_path(self._still_frame_path)
            if image is not None:
                self.frame_image = image
                self.update()
        except Exception:
            # Qt VideoSink 仍可能提供帧；ffmpeg 抽帧只是更确定的暂停/步进增强。
            pass

    def _on_frame_image_path(self, path: Path):
        from PySide6.QtGui import QImage

        image = QImage(str(path))
        return None if image.isNull() else image

    def _on_position_ms(self, ms: int) -> None:
        # 拖动/步进后 player 可能异步回报位置；播放时取消选中 pin，跟随时间线。
        if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.current_cue_id = None
            self.time = ms / 1000.0
            self.timeChanged.emit(self.time)
        self.update()

    def _on_frame(self, frame) -> None:
        image = frame.toImage()
        if not image.isNull():
            self.frame_image = image
        self.update()

    def display_rect(self) -> Rect:
        return fitted_video_rect(
            self.width(), self.height(), self.video_width, self.video_height
        )

    def _to_source(self, x: float, y: float) -> tuple[float, float]:
        return widget_to_source(
            x,
            y,
            self.width(),
            self.height(),
            self.video_width,
            self.video_height,
        )

    def _source_handle_margin(self) -> float:
        dest = self.display_rect()
        if dest.w <= 0:
            return 8.0
        return 10.0 * self.video_width / dest.w

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        # 源坐标模型不变；这里只需按新控件尺寸重绘。
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#111827"))
        dest = self.display_rect()
        if dest.w <= 0:
            return

        target = QRectF(dest.x, dest.y, dest.w, dest.h)
        if self.frame_image is not None and not self.frame_image.isNull():
            p.drawImage(target, self.frame_image)
        else:
            p.fillRect(target, QColor("#0b1220"))

        scale = dest.w / self.video_width
        p.save()
        p.setClipRect(target)
        p.translate(dest.x, dest.y)
        p.scale(scale, scale)

        self._paint_obstacles(p)
        if self.show_candidates:
            self._paint_candidates(p)
        self._paint_subtitles(p)
        if self._draft is not None:
            self._paint_rect(
                p, self._draft, QColor("#22c55e"), QColor(34, 197, 94, 55), draft=True
            )
        p.restore()

        # 视频边框
        p.setPen(QPen(QColor(148, 163, 184, 180), 1.5))
        p.drawRect(target)

    def _current_cue(self) -> Cue | None:
        if self.current_cue_id:
            cue = next((c for c in self.cues if c.id == self.current_cue_id), None)
            if cue:
                return cue
        active = [c for c in self.cues if c.contains(self.time + 1e-7)]
        # 重叠字幕时后一条在 ffmpeg overlay 链中位于更上层，审查/拖拽也以它为主。
        return active[-1] if active else None

    def _visible_cues(self) -> list[Cue]:
        """与导出一致：重叠 SRT 会在同一时刻同时显示多条。"""
        active = [c for c in self.cues if c.contains(self.time + 1e-7)]
        if self.current_cue_id:
            pinned = next((c for c in self.cues if c.id == self.current_cue_id), None)
            if pinned is not None:
                # 行选审查且时间已离开该句时，只显示这句供编辑；播放会清除 pin。
                if not pinned.contains(self.time + 1e-7):
                    return [pinned]
                if pinned not in active:
                    active.append(pinned)
        return active

    def _paint_obstacles(self, p: QPainter) -> None:
        cue = self._current_cue()
        relevant_ids: set[str] = set()
        if cue is not None and self.store is not None:
            relevant_ids = {
                o.id for o in self.store.planner.relevant_obstacles(cue, self.obstacles)
            }
        active = {o.id for o in obstacles_at(self.obstacles, self.time + 1e-7)}
        for o in self.obstacles:
            is_active = o.id in active
            is_relevant = o.id in relevant_ids
            color = QColor(o.color)
            fill = QColor(color)
            fill.setAlpha(70 if is_active else (28 if is_relevant else 12))
            width = 4 if o.id == self.selected_obstacle_id else 2.5
            pen = QPen(color, width)
            if not is_active:
                pen.setStyle(Qt.PenStyle.DashLine)
            p.setPen(pen)
            p.setBrush(fill)
            p.drawRect(QRectF(o.rect.x, o.rect.y, o.rect.w, o.rect.h))

            label = f"{o.name}  {o.start:.1f}-{o.end:.1f}s"
            font = p.font()
            font.setPixelSize(22)
            font.setBold(True)
            p.setFont(font)
            metrics = p.fontMetrics()
            tw = metrics.horizontalAdvance(label) + 16
            ly = max(0.0, o.rect.y - 30)
            p.fillRect(QRectF(o.rect.x, ly, tw, 30), color)
            p.setPen(QColor("white"))
            p.drawText(QRectF(o.rect.x + 8, ly, tw - 8, 30), Qt.AlignmentFlag.AlignVCenter, label)

    def _paint_candidates(self, p: QPainter) -> None:
        cue = self._current_cue()
        if cue is None or self.store is None:
            return
        planner = self.store.planner
        _, boxes = planner.candidate_boxes(cue.text)
        safe, collisions = planner.safe_slots_at_time(cue, self.time + 1e-7, self.obstacles)
        for slot_id, box in boxes.items():
            ok = slot_id in safe
            color = QColor("#22c55e" if ok else "#ef4444")
            pen = QPen(color, 2.5)
            pen.setStyle(Qt.PenStyle.DotLine if ok else Qt.PenStyle.DashLine)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRect(QRectF(box.x, box.y, box.w, box.h))
            p.setFont(self._label_font(18))
            p.drawText(QPointF(box.x + 6, box.y - 6), slot_id)

    def _paint_subtitles(self, p: QPainter) -> None:
        if self.store is None:
            return
        cues = self._visible_cues()
        current = self._current_cue()
        for cue in cues:
            self._paint_subtitle(p, cue, emphasized=current is not None and cue.id == current.id)

    def _paint_subtitle(self, p: QPainter, cue: Cue, emphasized: bool = True) -> None:
        if self.store is None:
            return
        placement = self.placements.get(cue.id)
        if placement is None:
            return
        box = placement.box
        dragging_this = (
            emphasized
            and self._manual_drag_pos is not None
            and self._drag_manual is not None
            and self._drag_manual[0] == cue.id
        )
        if dragging_this:
            box = self._manual_drag_pos

        laid = self.store.planner.layouts.layout(cue.text)
        render_subtitle(p, laid, box, self.store.planner.style)

        active_obstacles = obstacles_at(self.obstacles, self.time + 1e-7)
        collision_now = self.store.planner.collisions_for_box(box, active_obstacles)
        relevant = self.store.planner.relevant_obstacles(cue, self.obstacles)
        collision_whole = self.store.planner.collisions_for_box(box, relevant)

        if collision_now:
            color = QColor("#ef4444")
        elif collision_whole:
            color = QColor("#f59e0b")
        else:
            color = QColor("#22c55e")

        if emphasized:
            pen = QPen(color, 4)
            if collision_whole and not collision_now:
                pen.setStyle(Qt.PenStyle.DashLine)
        else:
            # 重叠字幕中的非主审查句仍画出边界，但不抢标签。
            pen = QPen(QColor(255, 255, 255, 170), 1.5)
            pen.setStyle(Qt.PenStyle.DotLine)
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(QRectF(box.x - 2, box.y - 2, box.w + 4, box.h + 4))

        if not emphasized:
            return

        tag = "人工位置" if placement.manual else placement.slot_id
        if collision_now:
            tag += " · 当前帧相碰"
        elif collision_whole:
            tag += " · 整条时间窗仍相碰"
        p.setFont(self._label_font(20, bold=True))
        tw = p.fontMetrics().horizontalAdvance(tag) + 18
        p.fillRect(QRectF(box.x, max(0, box.y - 34), tw, 30), color)
        label_color = QColor("white") if collision_now or collision_whole else QColor("#052e16")
        p.setPen(label_color)
        p.drawText(QRectF(box.x + 9, max(0, box.y - 34), tw - 9, 30), Qt.AlignmentFlag.AlignVCenter, tag)

    def _label_font(self, size: int, bold: bool = False):
        from PySide6.QtGui import QFont

        f = QFont()
        f.setPixelSize(size)
        f.setBold(bold)
        return f

    def _paint_rect(self, p, rect: Rect, color: QColor, fill: QColor, draft: bool = False) -> None:
        pen = QPen(color, 3)
        if draft:
            pen.setStyle(Qt.PenStyle.DashLine)
        p.setPen(pen)
        p.setBrush(fill)
        p.drawRect(QRectF(rect.x, rect.y, rect.w, rect.h))

    def mousePressEvent(self, event) -> None:  # noqa: N802
        sx, sy = self._to_source(event.position().x(), event.position().y())
        if event.button() != Qt.MouseButton.LeftButton:
            return

        if self.interaction_mode == "manual":
            cue = self._current_cue()
            placement = self.placements.get(cue.id) if cue else None
            if cue and placement:
                margin = self._source_handle_margin()
                if placement.box.contains_point(sx, sy, margin):
                    self._drag_manual = (cue.id, sx - placement.box.x, sy - placement.box.y)
                    self._manual_drag_pos = placement.box
                    return

        # 从最上层矩形开始选择/拖动。
        for obstacle in reversed(self.obstacles):
            margin = self._source_handle_margin()
            if obstacle.rect.contains_point(sx, sy, margin):
                self.selected_obstacle_id = obstacle.id
                self.obstacleSelected.emit(obstacle.id)
                self._drag_obstacle = (obstacle.id, sx - obstacle.rect.x, sy - obstacle.rect.y)
                self.update()
                return

        self.selected_obstacle_id = None
        self._draft_start = (sx, sy)
        self._draft = Rect(sx, sy, 0, 0)
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        sx, sy = self._to_source(event.position().x(), event.position().y())
        if self._drag_manual:
            cue_id, dx, dy = self._drag_manual
            old = self._manual_drag_pos
            if old is not None:
                self._manual_drag_pos = Rect(sx - dx, sy - dy, old.w, old.h)
                self.update()
            return

        if self._drag_obstacle:
            oid, dx, dy = self._drag_obstacle
            obstacle = next((o for o in self.obstacles if o.id == oid), None)
            if obstacle:
                obstacle.rect = Rect(sx - dx, sy - dy, obstacle.rect.w, obstacle.rect.h)
                self.update()
            return

        if event.buttons() & Qt.MouseButton.LeftButton and self._draft_start is not None:
            x0, y0 = self._draft_start
            self._draft = Rect.from_points(x0, y0, sx, sy)
            self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if self._drag_manual:
            cue_id, _, _ = self._drag_manual
            pos = self._manual_drag_pos
            self._drag_manual = None
            self._manual_drag_pos = None
            if pos is not None:
                pos = pos.clamped_to(Rect(0, 0, self.video_width, self.video_height))
                self.manualPositionCommitted.emit(cue_id, pos.x, pos.y)
            return

        if self._drag_obstacle:
            oid, _, _ = self._drag_obstacle
            self._drag_obstacle = None
            obstacle = next((o for o in self.obstacles if o.id == oid), None)
            if obstacle:
                obstacle.rect = obstacle.rect.clamped_to(
                    Rect(0, 0, self.video_width, self.video_height)
                )
                self.obstacleGeometryChanged.emit(oid, obstacle.rect)
            self.update()
            return

        if self._draft is not None:
            rect = self._draft
            self._draft = None
            self._draft_start = None
            if rect.w >= 6 and rect.h >= 6:
                rect = rect.clamped_to(Rect(0, 0, self.video_width, self.video_height))
                self.rectangleDrawn.emit(rect)
            self.update()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        if self.interaction_mode == "manual":
            cue = self._current_cue()
            if cue:
                self.manualPositionCommitted.emit(cue.id, float("nan"), float("nan"))
        super().mouseDoubleClickEvent(event)
