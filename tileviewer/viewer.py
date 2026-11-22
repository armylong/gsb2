"""Interactive zoomable canvas for the tiled preview pyramid.

The view state is kept entirely in *original-image* coordinates (a centre
point and a zoom factor measured in screen pixels per original pixel).
That is what makes a level switch keep the same spot under the mouse: the
level only changes which tiles are drawn, never the mapping to original
coordinates.  Overlays (tile borders, margin bands, pixel grid, selection,
reference crosshair) are all derived from the same mapping.
"""

from __future__ import annotations

import math
import os
from collections import OrderedDict
from pathlib import Path

from PySide6.QtCore import (
    QObject,
    QPointF,
    QRect,
    QRectF,
    QRunnable,
    Qt,
    QThreadPool,
    Signal,
)
from PySide6.QtGui import (
    QColor,
    QFont,
    QImage,
    QPainter,
    QPen,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from .cache import CacheManager, LevelState, LevelStatus
from .geometry import (
    Rect,
    TileSpec,
    choose_display_level,
    fit_zoom,
    map_original_to_level,
)

__all__ = ["ViewerWidget"]

MIN_ZOOM = 1.0 / 512.0
MAX_ZOOM = 64.0
_TILE_CACHE_LIMIT = 192


class _TileJob(QRunnable):
    def __init__(
        self,
        loader: TileLoader,
        level: int,
        col: int,
        row: int,
        path: Path,
        epoch: int,
    ) -> None:
        super().__init__()
        self._loader = loader
        self._level = level
        self._col = col
        self._row = row
        self._path = path
        self._epoch = epoch

    def run(self) -> None:  # pragma: no cover - exercised through the UI
        try:
            data = Path(self._path).read_bytes()
            image = QImage.fromData(data, "PNG")
            if image.isNull():
                raise ValueError("tile file is not a decodable PNG")
            if image.format() != QImage.Format.Format_RGB32:
                image = image.convertToFormat(QImage.Format.Format_RGB32)
            self._loader.loaded.emit(
                self._epoch, self._level, self._col, self._row, image
            )
        except Exception as exc:  # noqa: BLE001 - reported to the UI
            self._loader.failed.emit(
                self._epoch, self._level, self._col, self._row, str(exc)
            )


class TileLoader(QObject):
    loaded = Signal(int, int, int, int, QImage)
    failed = Signal(int, int, int, int, str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(max(2, min(6, os.cpu_count() or 2)))
        self._stopping = False

    def request(
        self, level: int, col: int, row: int, path: Path, epoch: int
    ) -> None:
        if self._stopping:
            return
        self.pool.start(_TileJob(self, level, col, row, path, epoch))

    def shutdown(self) -> None:
        self._stopping = True
        self.pool.clear()
        self.pool.waitForDone(3000)


class ViewerWidget(QWidget):
    cursorMoved = Signal(float, float)
    viewChanged = Signal(int, float)
    selectionChanged = Signal(object)
    hoveredTileChanged = Signal(object)
    notice = Signal(str)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMouseTracking(True)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding
        )
        self.setMinimumSize(320, 240)

        self.manager: CacheManager | None = None
        self.statuses: list[LevelStatus] = []
        self.level: int = -1
        self.center: tuple[float, float] = (0.0, 0.0)
        self.zoom: float = 1.0
        self.auto_level = True
        self.show_grid = False
        self.show_margins = False

        self._tiles: OrderedDict[tuple[int, int, int], QImage] = OrderedDict()
        self._pending: set[tuple[int, int, int]] = set()
        self._failed: dict[tuple[int, int, int], str] = {}
        self._epoch = 0
        self._loader = TileLoader(self)
        self._loader.loaded.connect(self._on_tile_loaded)
        self._loader.failed.connect(self._on_tile_failed)

        self._selection: tuple[float, float, float, float] | None = None
        self._drag_mode: str | None = None
        self._drag_anchor: QPointF | None = None
        self._pan_anchor: QPointF | None = None
        self._pan_center: tuple[float, float] | None = None
        self._space_held = False
        self._cursor_orig: tuple[float, float] | None = None
        self._hovered_tile: tuple | None = None
        self._drag_moved = False
        self._drag_press_pos: QPointF | None = None
        self._probe: tuple[float, float] | None = None

    # ------------------------------------------------------------------
    # source / configuration
    # ------------------------------------------------------------------
    @property
    def source(self):
        return self.manager.source if self.manager is not None else None

    @property
    def original_size(self) -> tuple[int, int]:
        if self.manager is None:
            return (0, 0)
        return (self.manager.source.width, self.manager.source.height)

    def set_source(self, manager: CacheManager | None) -> None:
        self.manager = manager
        self._tiles.clear()
        self._pending.clear()
        self._failed.clear()
        self._epoch += 1
        self._selection = None
        self._hovered_tile = None
        self.level = -1
        self.statuses = manager.statuses() if manager is not None else []
        if manager is not None:
            width, height = self.original_size
            self.center = (width / 2.0, height / 2.0)
            self.fit_to_view()
        self.selectionChanged.emit(None)
        self.hoveredTileChanged.emit(None)
        self.viewChanged.emit(self.level, self.zoom)
        self.update()

    def refresh_statuses(self, statuses: list[LevelStatus]) -> None:
        self.statuses = statuses
        if self.manager is None:
            return
        status_by_index = {status.index: status for status in statuses}
        # Drop cached tiles of levels that were rebuilt or invalidated.
        for key in list(self._tiles):
            status = status_by_index.get(key[0])
            if status is None or status.state is LevelState.STALE:
                self._tiles.pop(key, None)
        if self.level >= 0:
            status = status_by_index.get(self.level)
            if status is None or status.state is LevelState.STALE:
                self.level = -1
        if self.auto_level:
            self._apply_auto_level()
        self.viewChanged.emit(self.level, self.zoom)
        self.update()

    def clear_tile_cache(self) -> None:
        self._tiles.clear()
        self._pending.clear()
        self._failed.clear()
        self._epoch += 1
        self.update()

    def invalidate_levels(self, levels) -> None:
        """Forget cached bitmaps of levels whose tile files were rewritten."""
        levels = set(levels)
        if not levels:
            return
        # Bumping the epoch also discards in-flight loads of the old files.
        self._epoch += 1
        for key in [key for key in self._tiles if key[0] in levels]:
            self._tiles.pop(key, None)
        for key in [key for key in self._failed if key[0] in levels]:
            self._failed.pop(key, None)
        # Pending loads belong to the old epoch anyway; clearing lets the
        # redraw request them again immediately.
        self._pending.clear()
        if self.auto_level:
            self._apply_auto_level()
        self.viewChanged.emit(self.level, self.zoom)
        self.update()

    # ------------------------------------------------------------------
    # level and zoom control
    # ------------------------------------------------------------------
    def set_auto_level(self, enabled: bool) -> None:
        self.auto_level = bool(enabled)
        if self.auto_level:
            self._apply_auto_level()
            self.update()

    def set_level(self, index: int) -> None:
        if self.manager is None or not (0 <= index < self.manager.info.level_count):
            return
        if index == self.level:
            return
        # No centre / zoom change on purpose: the mapping is level agnostic,
        # so the original coordinate under every screen position is preserved.
        self.level = index
        self._hovered_tile = None
        self.hoveredTileChanged.emit(None)
        self.viewChanged.emit(self.level, self.zoom)
        self.update()

    def _apply_auto_level(self) -> None:
        if self.manager is None:
            return
        info = self.manager.info
        complete = [
            status.index
            for status in self.statuses
            if status.state is LevelState.COMPLETE
        ]
        if not complete:
            if self.level != -1:
                self.level = -1
                self.viewChanged.emit(self.level, self.zoom)
            return
        new_level = choose_display_level(
            info.sizes,
            complete,
            info.source_width,
            self.zoom,
        )
        if new_level != self.level:
            self.level = new_level
            self._hovered_tile = None
            self.hoveredTileChanged.emit(None)
            self.viewChanged.emit(self.level, self.zoom)

    def fit_to_view(self) -> None:
        if self.manager is None:
            return
        width, height = self.original_size
        self.zoom = fit_zoom(
            max(64, self.width()), max(64, self.height()), width, height, padding=10
        )
        self.zoom = self._clamp_zoom(self.zoom)
        self.center = (width / 2.0, height / 2.0)
        if self.auto_level:
            self._apply_auto_level()
        self.viewChanged.emit(self.level, self.zoom)
        self.update()

    def zoom_to(self, zoom: float, anchor: QPointF | None = None) -> None:
        if self.manager is None:
            return
        anchor = anchor or QPointF(self.width() / 2.0, self.height() / 2.0)
        original = self._widget_to_original(anchor)
        new_zoom = self._clamp_zoom(zoom)
        self.center = (
            original[0] - (anchor.x() - self.width() / 2.0) / new_zoom,
            original[1] - (anchor.y() - self.height() / 2.0) / new_zoom,
        )
        self.zoom = new_zoom
        if self.auto_level:
            self._apply_auto_level()
        self.viewChanged.emit(self.level, self.zoom)
        self._emit_cursor(anchor)
        self.update()

    def zoom_by(self, factor: float, anchor: QPointF | None = None) -> None:
        self.zoom_to(self.zoom * factor, anchor)

    def set_show_grid(self, enabled: bool) -> None:
        self.show_grid = bool(enabled)
        self.update()

    def set_show_margins(self, enabled: bool) -> None:
        self.show_margins = bool(enabled)
        self.update()

    # ------------------------------------------------------------------
    # selection
    # ------------------------------------------------------------------
    @property
    def selection(self) -> tuple[float, float, float, float] | None:
        return self._selection

    def selection_pixel_rect(self) -> Rect | None:
        """Selection snapped to the original pixel grid (may exceed bounds)."""
        if self._selection is None:
            return None
        x0, y0, x1, y1 = self._selection
        left = math.floor(min(x0, x1))
        top = math.floor(min(y0, y1))
        right = math.ceil(max(x0, x1))
        bottom = math.ceil(max(y0, y1))
        width, height = right - left, bottom - top
        if width <= 0 or height <= 0:
            return None
        return Rect(left, top, width, height)

    def clear_selection(self) -> None:
        if self._selection is None:
            return
        self._selection = None
        self.selectionChanged.emit(None)
        self.update()

    @property
    def probe(self) -> tuple[float, float] | None:
        """Anchor point in original coordinates used to check alignment."""
        return self._probe

    def set_probe(self, x: float, y: float) -> None:
        self._probe = (float(x), float(y))
        self.update()

    def clear_probe(self) -> None:
        self._probe = None
        self.update()

    def set_selection_pixels(self, rect: Rect) -> None:
        self._selection = (
            float(rect.x),
            float(rect.y),
            float(rect.x2),
            float(rect.y2),
        )
        self.selectionChanged.emit(self.selection_pixel_rect())
        self.update()

    def _set_selection_from_points(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        shift: bool = False,
    ) -> None:
        """Update the selection; ``shift`` keeps the aspect ratio square."""
        dx = end[0] - start[0]
        dy = end[1] - start[1]
        if shift:
            side = max(abs(dx), abs(dy))
            dx = math.copysign(side, dx if dx else 1.0)
            dy = math.copysign(side, dy if dy else 1.0)
        self._selection = (start[0], start[1], start[0] + dx, start[1] + dy)
        self.selectionChanged.emit(self.selection_pixel_rect())
        self.update()

    # ------------------------------------------------------------------
    # coordinate helpers
    # ------------------------------------------------------------------
    def _clamp_zoom(self, zoom: float) -> float:
        return max(MIN_ZOOM, min(MAX_ZOOM, zoom))

    def _widget_to_original(self, point: QPointF) -> tuple[float, float]:
        return (
            self.center[0] + (point.x() - self.width() / 2.0) / self.zoom,
            self.center[1] + (point.y() - self.height() / 2.0) / self.zoom,
        )

    def _original_to_widget(self, x: float, y: float) -> QPointF:
        return QPointF(
            (x - self.center[0]) * self.zoom + self.width() / 2.0,
            (y - self.center[1]) * self.zoom + self.height() / 2.0,
        )

    def _level_scales(self) -> tuple[float, float]:
        info = self.manager.info
        geom = self.manager.geometry(max(0, self.level))
        return (
            geom.width / info.source_width,
            geom.height / info.source_height,
        )

    def _level_rect_to_widget(
        self, geom, rect: Rect
    ) -> QRectF:
        info = self.manager.info
        sx = geom.width / info.source_width
        sy = geom.height / info.source_height
        top_left = self._original_to_widget(rect.x / sx, rect.y / sy)
        bottom_right = self._original_to_widget(rect.x2 / sx, rect.y2 / sy)
        return QRectF(top_left, bottom_right).normalized()

    @staticmethod
    def _snap(rect: QRectF) -> QRect:
        x0 = round(rect.x())
        y0 = round(rect.y())
        x1 = round(rect.x() + rect.width())
        y1 = round(rect.y() + rect.height())
        return QRect(x0, y0, max(0, x1 - x0), max(0, y1 - y0))

    def _visible_level_rect(self, geom) -> Rect:
        x0, y0 = self._widget_to_original(QPointF(0.0, 0.0))
        x1, y1 = self._widget_to_original(
            QPointF(float(self.width()), float(self.height()))
        )
        info = self.manager.info
        sx = geom.width / info.source_width
        sy = geom.height / info.source_height
        rect = Rect(
            math.floor(x0 * sx),
            math.floor(y0 * sy),
            math.ceil(x1 * sx) - math.floor(x0 * sx),
            math.ceil(y1 * sy) - math.floor(y0 * sy),
        )
        return rect.clipped_to(geom.bounds)

    def _status_for(self, index: int) -> LevelStatus | None:
        for status in self.statuses:
            if status.index == index:
                return status
        return None

    # ------------------------------------------------------------------
    # tiles
    # ------------------------------------------------------------------
    def _tile_key(self, level: int, col: int, row: int) -> tuple[int, int, int]:
        return level, col, row

    def _lookup_tile(self, tile: TileSpec) -> QImage | None:
        key = self._tile_key(self.level, tile.col, tile.row)
        image = self._tiles.get(key)
        if image is not None:
            self._tiles.move_to_end(key)
            return image
        if key in self._pending or key in self._failed:
            return None
        status = self._status_for(self.level)
        if status is None or status.state is LevelState.STALE:
            return None
        path = self.manager.tile_path(self.level, tile.col, tile.row)
        if not path.exists():
            self._failed[key] = "missing"
            return None
        self._pending.add(key)
        self._loader.request(
            self.level, tile.col, tile.row, path, self._epoch
        )
        return None

    def _on_tile_loaded(
        self, epoch: int, level: int, col: int, row: int, image: QImage
    ) -> None:
        key = (level, col, row)
        self._pending.discard(key)
        if epoch != self._epoch:
            return
        self._tiles[key] = image
        while len(self._tiles) > _TILE_CACHE_LIMIT:
            self._tiles.popitem(last=False)
        if level == self.level:
            self.update()

    def _on_tile_failed(
        self, epoch: int, level: int, col: int, row: int, message: str
    ) -> None:
        key = (level, col, row)
        self._pending.discard(key)
        if epoch != self._epoch:
            return
        self._failed[key] = message
        if level == self.level:
            self.update()

    # ------------------------------------------------------------------
    # painting
    # ------------------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(30, 31, 35))

        if self.manager is None:
            self._paint_hint(painter, "打开一张本地单帧 RGB 图像开始")
            return

        if self.level < 0:
            text = (
                "当前缩放没有可用的完整层级\n"
                "请在左侧生成预览块，或降低缩放"
            )
            self._paint_hint(painter, text)
            return

        status = self._status_for(self.level)
        geom = self.manager.geometry(self.level)
        visible = self._visible_level_rect(geom)
        if visible.is_empty:
            return

        info = self.manager.info
        minifying = (
            self.zoom / (geom.width / info.source_width) < 1.0
        )
        painter.setRenderHint(
            QPainter.RenderHint.SmoothPixmapTransform, minifying
        )

        image_bounds = self._snap(self._level_rect_to_widget(geom, geom.bounds))
        painter.fillRect(image_bounds, QColor(12, 12, 14))

        for tile in geom.tiles_intersecting(visible):
            key = self._tile_key(self.level, tile.col, tile.row)
            target = self._snap(self._level_rect_to_widget(geom, tile.core))
            image = self._lookup_tile(tile)
            if image is None:
                painter.fillRect(
                    target,
                    QColor(90, 40, 40)
                    if key in self._failed
                    else QColor(52, 53, 58),
                )
                continue
            if minifying and tile.full != tile.core:
                # When minifying, draw from the full region (core + margins)
                # so the filter has real neighbours to sample, then clip to
                # the official core: overlap never double-draws, and there
                # are no seams between tiles.
                painter.save()
                painter.setClipRect(target)
                painter.drawImage(
                    self._snap(self._level_rect_to_widget(geom, tile.full)),
                    image,
                    QRect(0, 0, tile.full.w, tile.full.h),
                )
                painter.restore()
            else:
                source_rect = QRect(
                    tile.core.x - tile.full.x,
                    tile.core.y - tile.full.y,
                    tile.core.w,
                    tile.core.h,
                )
                painter.drawImage(target, image, source_rect)

        if self.show_margins:
            self._paint_margins(painter, geom, visible)
        if self.show_grid:
            self._paint_grid(painter, geom, visible, image_bounds)

        pen = QPen(QColor(70, 170, 255, 200), 1.0)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(image_bounds.adjusted(0, 0, -1, -1))

        if status is not None and status.state is LevelState.PARTIAL:
            self._paint_badge(
                painter,
                f"L{status.index:02d} 未完成：{status.tiles_present}/"
                f"{status.tile_count} 块",
                QColor(200, 140, 40, 220),
            )

        self._paint_selection(painter)
        self._paint_probe(painter)
        self._paint_cursor_readout(painter)

    def _paint_hint(self, painter: QPainter, text: str) -> None:
        painter.setPen(QColor(190, 192, 200))
        font = QFont()
        font.setPointSizeF(11.0)
        painter.setFont(font)
        painter.drawText(
            self.rect().adjusted(24, 24, -24, -24),
            Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap,
            text,
        )

    def _paint_badge(self, painter: QPainter, text: str, color: QColor) -> None:
        font = QFont()
        font.setPointSizeF(9.0)
        painter.setFont(font)
        metrics = painter.fontMetrics()
        width = metrics.horizontalAdvance(text) + 16
        height = metrics.height() + 8
        rect = QRect(self.width() - width - 12, 12, width, height)
        painter.fillRect(rect, color)
        painter.setPen(QColor(20, 20, 20))
        painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, text)

    def _paint_margins(self, painter: QPainter, geom, visible: Rect) -> None:
        fill = QColor(255, 0, 190, 46)
        edge = QPen(QColor(255, 80, 210, 190), 1.0, Qt.PenStyle.DashLine)
        painter.save()
        for tile in geom.tiles_intersecting(visible):
            if tile.core == tile.full:
                continue
            top = Rect(
                tile.full.x, tile.full.y, tile.full.w, tile.core.y - tile.full.y
            )
            bottom = Rect(
                tile.full.x,
                tile.core.y2,
                tile.full.w,
                tile.full.y2 - tile.core.y2,
            )
            left = Rect(
                tile.full.x, tile.core.y, tile.core.x - tile.full.x, tile.core.h
            )
            right = Rect(
                tile.core.x2,
                tile.core.y,
                tile.full.x2 - tile.core.x2,
                tile.core.h,
            )
            for band in (top, bottom, left, right):
                if band.is_empty:
                    continue
                painter.fillRect(
                    self._snap(self._level_rect_to_widget(geom, band)), fill
                )
            # Only the official core area gets a dashed outline.
            painter.setPen(edge)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(
                self._snap(self._level_rect_to_widget(geom, tile.core)).adjusted(
                    0, 0, -1, -1
                )
            )
        painter.restore()

    def _paint_grid(
        self, painter: QPainter, geom, visible: Rect, image_bounds: QRect
    ) -> None:
        painter.save()
        painter.setClipRect(image_bounds)
        font = QFont()
        font.setPointSizeF(8.0)
        painter.setFont(font)

        # Tile boundaries of the current level.
        tile_pen = QPen(QColor(255, 150, 40, 175), 1.0)
        level_pen = QPen(QColor(70, 170, 255, 210), 1.2)
        scale_x = geom.width / self.manager.info.source_width
        scale_y = geom.height / self.manager.info.source_height
        painter.setPen(tile_pen)
        for col in range(geom.cols + 1):
            x = min(geom.width, col * geom.tile_size)
            point = self._original_to_widget(x / scale_x, 0.0)
            painter.drawLine(
                QPointF(point.x(), image_bounds.top()),
                QPointF(point.x(), image_bounds.bottom() + 1),
            )
        for row in range(geom.rows + 1):
            y = min(geom.height, row * geom.tile_size)
            point = self._original_to_widget(0.0, y / scale_y)
            painter.drawLine(
                QPointF(image_bounds.left(), point.y()),
                QPointF(image_bounds.right() + 1, point.y()),
            )

        # Tile index labels when there is room.
        tile_screen_w = geom.tile_size / scale_x * self.zoom
        tile_screen_h = geom.tile_size / scale_y * self.zoom
        if tile_screen_w > 72 and tile_screen_h > 30:
            painter.setPen(QColor(255, 190, 120, 230))
            for tile in geom.tiles_intersecting(visible):
                point = self._original_to_widget(
                    tile.core.x / scale_x, tile.core.y / scale_y
                )
                painter.drawText(
                    QPointF(point.x() + 4, point.y() + 12),
                    f"c{tile.col} r{tile.row}",
                )

        # Original-pixel grid, with a step that keeps labels readable.
        if self.zoom >= 0.02:
            step = self._nice_step(64.0 / self.zoom)
            grid_pen = QPen(QColor(120, 200, 255, 90), 1.0)
            painter.setPen(grid_pen)
            start_x = math.floor(visible.x / scale_x / step) * step
            x = start_x
            while x <= visible.x2 / scale_x:
                if x >= 0:
                    point = self._original_to_widget(x, 0.0)
                    painter.drawLine(
                        QPointF(point.x(), image_bounds.top()),
                        QPointF(point.x(), image_bounds.bottom() + 1),
                    )
                x += step
            start_y = math.floor(visible.y / scale_y / step) * step
            y = start_y
            while y <= visible.y2 / scale_y:
                if y >= 0:
                    point = self._original_to_widget(0.0, y)
                    painter.drawLine(
                        QPointF(image_bounds.left(), point.y()),
                        QPointF(image_bounds.right() + 1, point.y()),
                    )
                y += step

            # Labels along the top/left edge of the viewport.
            painter.setPen(QColor(170, 220, 255, 210))
            label_y = max(image_bounds.top() + 12, 12)
            x = start_x
            while x <= visible.x2 / scale_x:
                if x >= 0:
                    point = self._original_to_widget(x, 0.0)
                    painter.drawText(QPointF(point.x() + 2, label_y), f"{int(x)}")
                x += step
            label_x = max(image_bounds.left() + 4, 4)
            y = start_y
            while y <= visible.y2 / scale_y:
                if y >= 0:
                    point = self._original_to_widget(0.0, y)
                    painter.drawText(
                        QPointF(label_x, point.y() - 2), f"{int(y)}"
                    )
                y += step

        painter.setPen(level_pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(image_bounds.adjusted(0, 0, -1, -1))
        painter.restore()

    @staticmethod
    def _nice_step(minimum: float) -> float:
        exponent = 0
        while True:
            for base in (1.0, 2.0, 5.0):
                value = base * (10.0**exponent)
                if value >= minimum:
                    return value
            exponent += 1

    def _paint_selection(self, painter: QPainter) -> None:
        if self._selection is None:
            return
        x0, y0, x1, y1 = self._selection
        top_left = self._original_to_widget(min(x0, x1), min(y0, y1))
        bottom_right = self._original_to_widget(max(x0, x1), max(y0, y1))
        rect = QRectF(top_left, bottom_right).normalized()
        painter.save()
        painter.fillRect(rect, QColor(255, 220, 40, 46))
        painter.setPen(QPen(QColor(255, 235, 90, 230), 1.6, Qt.PenStyle.DashLine))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(rect)
        pixel_rect = self.selection_pixel_rect()
        if pixel_rect is not None:
            label = (
                f"x={pixel_rect.x} y={pixel_rect.y} "
                f"{pixel_rect.w}x{pixel_rect.h}"
            )
            font = QFont()
            font.setPointSizeF(9.0)
            painter.setFont(font)
            metrics = painter.fontMetrics()
            box = QRect(
                int(rect.left()),
                int(rect.top()) - metrics.height() - 6,
                metrics.horizontalAdvance(label) + 12,
                metrics.height() + 4,
            )
            if box.top() < 0:
                box.moveTop(int(rect.top()) + 2)
            painter.fillRect(box, QColor(20, 20, 24, 210))
            painter.setPen(QColor(255, 235, 120))
            painter.drawText(box, Qt.AlignmentFlag.AlignCenter, label)
        painter.restore()

    def _paint_probe(self, painter: QPainter) -> None:
        """Crosshair pinned to one original coordinate, drawn on every level.

        Switching levels must leave it exactly over the same image feature.
        """
        if self._probe is None or self.manager is None:
            return
        point = self._original_to_widget(*self._probe)
        painter.save()
        pen = QPen(QColor(60, 255, 200, 235), 1.4)
        painter.setPen(pen)
        arm = 11.0
        painter.drawLine(
            QPointF(point.x() - arm, point.y()),
            QPointF(point.x() + arm, point.y()),
        )
        painter.drawLine(
            QPointF(point.x(), point.y() - arm),
            QPointF(point.x(), point.y() + arm),
        )
        painter.setBrush(QColor(60, 255, 200, 50))
        painter.drawEllipse(point, 5.0, 5.0)
        if self.level >= 0:
            geom = self.manager.geometry(self.level)
            info = self.manager.info
            lx, ly = map_original_to_level(
                self._probe[0],
                self._probe[1],
                info.source_width,
                info.source_height,
                geom.width,
                geom.height,
            )
            label = (
                f"原图 ({self._probe[0]:.1f}, {self._probe[1]:.1f})  "
                f"L{self.level:02d} ({lx:.1f}, {ly:.1f})"
            )
            font = QFont()
            font.setPointSizeF(8.5)
            painter.setFont(font)
            metrics = painter.fontMetrics()
            box = QRect(
                int(point.x()) + 14,
                int(point.y()) - metrics.height() - 6,
                metrics.horizontalAdvance(label) + 12,
                metrics.height() + 4,
            )
            if box.right() > self.width():
                box.moveLeft(int(point.x()) - box.width() - 14)
            if box.top() < 0:
                box.moveTop(int(point.y()) + 8)
            painter.fillRect(box, QColor(10, 30, 26, 215))
            painter.setPen(QColor(120, 255, 220))
            painter.drawText(box, Qt.AlignmentFlag.AlignCenter, label)
        painter.restore()

    def _paint_cursor_readout(self, painter: QPainter) -> None:
        if self._cursor_orig is None or self.level < 0:
            return
        tile = self._hovered_tile
        if tile is None:
            return
        _, core, full = tile
        text = (
            f"L{self.level:02d}  core {core.x},{core.y} {core.w}x{core.h}"
            f"   full {full.x},{full.y} {full.w}x{full.h}"
        )
        painter.save()
        font = QFont()
        font.setPointSizeF(8.5)
        painter.setFont(font)
        metrics = painter.fontMetrics()
        box = QRect(
            8,
            self.height() - metrics.height() - 12,
            metrics.horizontalAdvance(text) + 14,
            metrics.height() + 6,
        )
        painter.fillRect(box, QColor(15, 16, 19, 205))
        painter.setPen(QColor(200, 205, 215))
        painter.drawText(box, Qt.AlignmentFlag.AlignCenter, text)
        painter.restore()

    # ------------------------------------------------------------------
    # events
    # ------------------------------------------------------------------
    @property
    def cursor_original(self) -> tuple[float, float] | None:
        return self._cursor_orig

    def _emit_cursor(self, position: QPointF) -> None:
        original = self._widget_to_original(position)
        self._cursor_orig = original
        self.cursorMoved.emit(original[0], original[1])
        self._update_hovered_tile(original)

    def _update_hovered_tile(self, original: tuple[float, float]) -> None:
        tile_info = None
        if self.manager is not None and self.level >= 0:
            geom = self.manager.geometry(self.level)
            info = self.manager.info
            sx = geom.width / info.source_width
            sy = geom.height / info.source_height
            col, row = (
                geom.tile_index_at(
                    math.floor(original[0] * sx), math.floor(original[1] * sy)
                )
                if original[0] >= 0 and original[1] >= 0
                else (None, None)
            )
            if col is not None and row is not None:
                tile = geom.tile(col, row)
                tile_info = (self.level, tile.core, tile.full)
        if tile_info != self._hovered_tile:
            self._hovered_tile = tile_info
            self.hoveredTileChanged.emit(tile_info)
            self.update()

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self.manager is None:
            return
        position = QPointF(event.position())
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton and self._space_held
        ):
            self._drag_mode = "pan"
            self._pan_anchor = position
            self._pan_center = self.center
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if event.button() == Qt.MouseButton.LeftButton:
            original = self._widget_to_original(position)
            self._drag_mode = "select"
            self._drag_anchor = QPointF(*original)
            self._drag_moved = False
            self._drag_press_pos = position
            self._selection = (original[0], original[1], original[0], original[1])
            self.selectionChanged.emit(None)
            self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt API
        position = QPointF(event.position())
        if self._drag_mode == "pan" and self._pan_anchor is not None:
            delta = position - self._pan_anchor
            self.center = (
                self._pan_center[0] - delta.x() / self.zoom,
                self._pan_center[1] - delta.y() / self.zoom,
            )
            self.viewChanged.emit(self.level, self.zoom)
            self.update()
        elif self._drag_mode == "select" and self._drag_anchor is not None:
            original = self._widget_to_original(position)
            if (
                self._drag_press_pos is not None
                and (position - self._drag_press_pos).manhattanLength() >= 2
            ):
                self._drag_moved = True
            self._set_selection_from_points(
                (self._drag_anchor.x(), self._drag_anchor.y()),
                original,
                shift=bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier),
            )
        self._emit_cursor(position)
        if self._drag_mode == "select":
            self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self._drag_mode == "pan":
            self._drag_mode = None
            self._pan_anchor = None
            self._pan_center = None
            self.unsetCursor()
            return
        if self._drag_mode == "select":
            self._drag_mode = None
            self._drag_anchor = None
            self._drag_press_pos = None
            # A click without a drag clears instead of leaving a 1x1 box.
            if not self._drag_moved or self.selection_pixel_rect() is None:
                self._selection = None
                self.selectionChanged.emit(None)
            else:
                self.selectionChanged.emit(self.selection_pixel_rect())
            self._drag_moved = False
            self.update()

    def wheelEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self.manager is None:
            return
        steps = event.angleDelta().y() / 120.0
        if steps == 0:
            return
        self.zoom_by(1.25**steps, QPointF(event.position()))
        event.accept()

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        self.update()

    def keyPressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.key() == Qt.Key.Key_Space:
            self._space_held = True
            self.setCursor(Qt.CursorShape.OpenHandCursor)
            event.accept()
            return
        step = max(1.0, 80.0 / self.zoom)
        moved = False
        if event.key() == Qt.Key.Key_Left:
            self.center = (self.center[0] - step, self.center[1])
            moved = True
        elif event.key() == Qt.Key.Key_Right:
            self.center = (self.center[0] + step, self.center[1])
            moved = True
        elif event.key() == Qt.Key.Key_Up:
            self.center = (self.center[0], self.center[1] - step)
            moved = True
        elif event.key() == Qt.Key.Key_Down:
            self.center = (self.center[0], self.center[1] + step)
            moved = True
        elif event.key() == Qt.Key.Key_Escape:
            self.clear_selection()
            self.clear_probe()
            moved = True
        if moved:
            self.viewChanged.emit(self.level, self.zoom)
            self.update()
            event.accept()
            return
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.key() == Qt.Key.Key_Space:
            self._space_held = False
            self.unsetCursor()
            event.accept()
            return
        super().keyReleaseEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802 - Qt API
        self._cursor_orig = None
        if self._hovered_tile is not None:
            self._hovered_tile = None
            self.hoveredTileChanged.emit(None)
        self.update()
        super().leaveEvent(event)

    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        self._loader.shutdown()

    def map_original_to_widget(self, x: float, y: float) -> QPointF:
        """Public helper used by tests and screenshots."""
        return self._original_to_widget(x, y)
