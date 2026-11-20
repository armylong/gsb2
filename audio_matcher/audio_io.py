"""Load and write interview audio with an honest source fingerprint.

The fingerprint is a hash of the *file bytes*, not of the path.  That is what
lets the app tell "this is the same recording" from "someone re-exported a
different take into the same filename" after a project is reopened.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf


class AudioLoadError(RuntimeError):
    """Raised when a file cannot be decoded as audio."""


@dataclass(frozen=True)
class AudioClip:
    """One loaded recording, kept in memory as float64 mono + source bytes info."""

    path: str
    sample_rate: int
    samples: np.ndarray            # mono float64, shape (n,)
    source_channels: int
    source_subtype: str
    file_size: int
    file_mtime_ns: int
    fingerprint: str               # sha256 of file bytes

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def duration_s(self) -> float:
        return self.frames / float(self.sample_rate) if self.sample_rate else 0.0

    def sample_to_seconds(self, sample: int) -> float:
        return sample / float(self.sample_rate)

    def seconds_to_sample(self, seconds: float) -> int:
        return int(round(seconds * self.sample_rate))


def fingerprint_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_audio(path: str | Path) -> AudioClip:
    """Read a file to mono float64 at its native sample rate."""
    target = Path(path).expanduser().resolve()
    if not target.is_file():
        raise AudioLoadError(f"文件不存在: {target}")
    try:
        data, rate = sf.read(str(target), dtype="float64", always_2d=True)
    except Exception as exc:  # soundfile raises several libsndfile variants
        raise AudioLoadError(f"无法解码音频: {target.name}: {exc}") from exc
    if rate <= 0 or data.size == 0:
        raise AudioLoadError(f"音频为空: {target.name}")
    channels = int(data.shape[1])
    mono = data.mean(axis=1) if channels > 1 else data[:, 0]
    info = sf.info(str(target))
    stat = target.stat()
    return AudioClip(
        path=str(target),
        sample_rate=int(rate),
        samples=np.ascontiguousarray(mono, dtype=np.float64),
        source_channels=channels,
        source_subtype=str(info.subtype),
        file_size=int(stat.st_size),
        file_mtime_ns=int(stat.st_mtime_ns),
        fingerprint=fingerprint_file(target),
    )


def write_wav(path: str | Path, samples: np.ndarray, sample_rate: int) -> None:
    """Write 24-bit PCM, peak-safe, atomically enough for a desktop app."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0)
    sf.write(str(target), data, int(sample_rate), subtype="PCM_24")


@dataclass(frozen=True)
class SourceSnapshot:
    """The identity of a source file, as stored in a project."""

    path: str
    fingerprint: str
    file_size: int
    file_mtime_ns: int

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "fingerprint": self.fingerprint,
            "file_size": self.file_size,
            "file_mtime_ns": self.file_mtime_ns,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SourceSnapshot":
        return cls(
            path=str(data.get("path", "")),
            fingerprint=str(data.get("fingerprint", "")),
            file_size=int(data.get("file_size", 0)),
            file_mtime_ns=int(data.get("file_mtime_ns", 0)),
        )


@dataclass(frozen=True)
class SourceChange:
    """How a source file differs from what the project recorded."""

    path: str
    reason: str  # "missing" | "changed"

    @property
    def message(self) -> str:
        if self.reason == "missing":
            return f"源文件已不存在: {self.path}"
        return f"源文件内容已变更: {self.path}"


def compare_source(snapshot: SourceSnapshot) -> SourceChange | None:
    """Return a change description, or ``None`` when the file is identical.

    The hash is always computed rather than trusting size/mtime: a re-export
    into the same filename often keeps the size, and editors can preserve
    mtimes when copying.  Interview clips are short enough that hashing on
    project open is cheap.  A snapshot without a fingerprint (an older
    project file) cannot be compared, so it is treated as unchanged rather
    than guessing.
    """
    path = Path(snapshot.path)
    if not path.is_file():
        return SourceChange(path=str(path), reason="missing")
    if not snapshot.fingerprint:
        return None
    if fingerprint_file(path) != snapshot.fingerprint:
        return SourceChange(path=str(path), reason="changed")
    return None


def detect_source_changes(snapshots: dict[str, SourceSnapshot]) -> dict[str, SourceChange]:
    changes: dict[str, SourceChange] = {}
    for key, snapshot in snapshots.items():
        change = compare_source(snapshot)
        if change is not None:
            changes[key] = change
    return changes


