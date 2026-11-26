"""参考音集合与索引。

索引 = 每条参考的帧特征 + 生成号(generation)。增删/替换只重建受影响的一条，
但 generation 会自增，UI 用它确认"候选来自当前这版索引"，避免旧结果残留。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from .audio import AudioLoadError, LoadedAudio, load_audio
from .features import EmptyAudioError, FeatureConfig, FeatureSet, extract_features

READY = "ready"
LOADING = "loading"
ERROR = "error"
EMPTY = "empty"


def _file_fingerprint(path: Path) -> str:
    """快速内容指纹（路径 + 大小 + mtime）。替换文件后必然变化。"""
    try:
        st = path.stat()
    except OSError:
        return f"{path}|missing"
    return f"{path}|{st.st_size}|{int(st.st_mtime_ns)}"


@dataclass
class Reference:
    path: str
    label: str
    status: str = LOADING
    error: str = ""
    duration: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    loaded: LoadedAudio | None = None
    features: FeatureSet | None = None
    fingerprint: str = ""
    revision: int = 0

    @property
    def ready(self) -> bool:
        return self.status == READY and self.features is not None

    @property
    def active_duration(self) -> float:
        return self.features.active_duration if self.features else 0.0

    def status_text(self) -> str:
        if self.status == READY:
            return "就绪"
        if self.status == ERROR:
            return f"失败: {self.error}"
        if self.status == EMPTY:
            return f"不可用: {self.error}"
        return "载入中"

    def detail_text(self) -> str:
        if self.status != READY or self.features is None:
            return self.error or "—"
        f = self.features
        return (f"{f.duration:.2f}s / 有效 {f.active_duration:.2f}s · "
                f"{f.cfg.fs}Hz · {f.cfg.n_mels}band")


def _load_reference(ref: Reference, cfg: FeatureConfig) -> None:
    ref.status = LOADING
    ref.error = ""
    ref.features = None
    try:
        audio = load_audio(ref.path)
    except AudioLoadError as exc:
        ref.status = ERROR
        ref.error = str(exc)
        ref.loaded = None
        return
    ref.loaded = audio
    ref.duration = audio.duration
    ref.sample_rate = audio.sample_rate
    ref.channels = audio.channels
    try:
        ref.features = extract_features(audio.samples, cfg)
    except EmptyAudioError as exc:
        ref.status = EMPTY
        ref.error = f"静音或无有效能量（{exc}）"
        return
    except Exception as exc:  # noqa: BLE001
        ref.status = ERROR
        ref.error = f"分析失败: {exc}"
        return
    ref.status = READY


class ReferenceIndex:
    def __init__(self, cfg: FeatureConfig | None = None):
        self.cfg = cfg or FeatureConfig()
        self._refs: dict[str, Reference] = {}
        self.generation = 0

    # ---- 集合维护 ----
    def add(self, path: str | Path) -> Reference:
        p = Path(path)
        ref = Reference(path=str(p.resolve()), label=p.stem)
        _load_reference(ref, self.cfg)
        ref.fingerprint = _file_fingerprint(p)
        ref.revision = 1
        self._refs[ref.path] = ref
        self.generation += 1
        return ref

    def remove(self, path: str) -> None:
        key = str(Path(path).resolve())
        if key in self._refs:
            del self._refs[key]
            self.generation += 1

    def reload(self, path: str) -> Reference | None:
        key = str(Path(path).resolve())
        ref = self._refs.get(key)
        if ref is None:
            return None
        _load_reference(ref, self.cfg)
        ref.fingerprint = _file_fingerprint(Path(key))
        ref.revision += 1
        self.generation += 1
        return ref

    def refresh_if_changed(self, path: str) -> Reference | None:
        key = str(Path(path).resolve())
        ref = self._refs.get(key)
        if ref is None:
            return None
        if ref.fingerprint != _file_fingerprint(Path(key)):
            return self.reload(key)
        if not ref.ready:
            return self.reload(key)
        return ref

    def clear(self) -> None:
        self._refs.clear()
        self.generation += 1

    def get(self, path: str) -> Reference | None:
        return self._refs.get(str(Path(path).resolve()))

    def all(self) -> list[Reference]:
        return list(self._refs.values())

    def ready(self) -> list[Reference]:
        return [r for r in self._refs.values() if r.ready]

    def failed(self) -> list[Reference]:
        return [r for r in self._refs.values() if not r.ready]

    def signature(self) -> str:
        """索引内容指纹：用于验证 UI 显示与索引一致。"""
        h = hashlib.sha1()
        h.update(str(self.generation).encode())
        for ref in sorted(self._refs.values(), key=lambda r: r.path):
            h.update(ref.path.encode())
            h.update(ref.fingerprint.encode())
            h.update(ref.status.encode())
            if ref.features is not None:
                h.update(str(ref.features.n).encode())
                h.update(hashlib.sha1(ref.features.feats.tobytes()).hexdigest().encode())
        return h.hexdigest()[:16]
