"""短片播放: 用 QMediaPlayer 放整段, 用自带的音频片段播放器放打点附近的小段."""

from __future__ import annotations

import os
from PySide6.QtCore import QObject, QUrl, Signal, Slot
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer


class FilmPlayer(QObject):
    """整片播放器 (画面由外部 QLabel/QVideoWidget 显示, 这里只管时间和声音)."""

    positionChanged = Signal(int)     # ms
    durationChanged = Signal(int)     # ms
    stateChanged = Signal(object)     # QMediaPlayer.PlaybackState
    errorOccurred = Signal(str)
    mediaLoaded = Signal(bool)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._player = QMediaPlayer(self)
        self._audio = QAudioOutput(self)
        self._audio.setVolume(1.0)
        try:
            self._audio.setMuted(True)   # 整片静音, 试听交给 AudioPlayer 保证精确
        except Exception:
            pass
        self._player.setAudioOutput(self._audio)
        self._player.positionChanged.connect(self._emit_position)
        self._player.durationChanged.connect(self._emit_duration)
        self._player.playbackStateChanged.connect(self._emit_state)
        self._player.errorOccurred.connect(self._on_error)
        self._player.mediaStatusChanged.connect(self._on_status)

    def _emit_position(self, p: int) -> None:
        self.positionChanged.emit(int(p))

    def _emit_duration(self, d: int) -> None:
        self.durationChanged.emit(int(d))

    def _emit_state(self, state) -> None:
        self.stateChanged.emit(state)

    # -- 公共接口 -----------------------------------------------------------
    def load(self, path: str) -> None:
        self._player.setSource(QUrl.fromLocalFile(os.path.abspath(path)))

    def play(self) -> None:
        self._player.play()

    def pause(self) -> None:
        self._player.pause()

    def stop(self) -> None:
        self._player.stop()

    def seek_ms(self, ms: int) -> None:
        self._player.setPosition(max(0, int(ms)))

    def position_ms(self) -> int:
        return int(self._player.position())

    def duration_ms(self) -> int:
        return int(self._player.duration())

    def is_playing(self) -> bool:
        return self._player.playbackState() == QMediaPlayer.PlayingState

    def set_volume(self, vol: float) -> None:
        """整片播放时是否让 QMediaPlayer 出声."""
        try:
            self._audio.setMuted(vol <= 0.001)
            self._audio.setVolume(max(0.0, min(1.0, vol)))
        except Exception:
            pass

    def release(self) -> None:
        try:
            self._player.stop()
            self._player.setSource(QUrl())
        except Exception:
            pass

    # -- 内部 ---------------------------------------------------------------
    @Slot()
    def _on_status(self, status) -> None:
        if status == QMediaPlayer.LoadedMedia:
            self.mediaLoaded.emit(True)
        elif status in (QMediaPlayer.NoMedia, QMediaPlayer.InvalidMedia):
            self.mediaLoaded.emit(False)

    def _on_error(self, err, text) -> None:
        if err != QMediaPlayer.NoError:
            self.errorOccurred.emit(str(text or err))
