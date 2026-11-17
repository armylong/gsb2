"""Qt table model listing per-frame storage and timing details."""

from __future__ import annotations

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt

from giftool.document import AnimationDocument


COLUMNS = [
    ("帧", 50),
    ("局部范围 (左,上,右,下)", 170),
    ("存储方式", 110),
    ("帧处置", 130),
    ("存储时长(ms)", 100),
    ("播放时长(ms)", 100),
    ("透明索引", 80),
]


class FrameTableModel(QAbstractTableModel):
    def __init__(self, document: AnimationDocument | None = None) -> None:
        super().__init__()
        self._document: AnimationDocument | None = None
        self.set_document(document)

    def set_document(self, document: AnimationDocument | None) -> None:
        self.beginResetModel()
        self._document = document
        self.endResetModel()

    def rowCount(self, parent: QModelIndex = QModelIndex()) -> int:
        if parent.isValid() or self._document is None:
            return 0
        return self._document.frame_count

    def columnCount(self, parent: QModelIndex = QModelIndex()) -> int:
        return len(COLUMNS)

    def headerData(self, section: int, orientation: Qt.Orientation,
                   role: int = Qt.ItemDataRole.DisplayRole):
        if role != Qt.ItemDataRole.DisplayRole:
            return None
        if orientation == Qt.Orientation.Horizontal:
            return COLUMNS[section][0]
        return section + 1

    def data(self, index: QModelIndex, role: int = Qt.ItemDataRole.DisplayRole):
        if not index.isValid() or self._document is None or role != Qt.ItemDataRole.DisplayRole:
            return None
        info = self._document.frame_info(index.row())
        bbox = ", ".join(str(v) for v in info.bbox)
        storage = "完整画布" if info.is_full_canvas else "局部图块"
        transparent = "—" if info.transparent_index is None else str(info.transparent_index)
        values = [
            str(info.index),
            bbox,
            storage,
            info.disposal_label,
            str(info.stored_duration_ms),
            str(info.effective_duration_ms),
            transparent,
        ]
        return values[index.column()]
