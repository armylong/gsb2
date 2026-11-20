"""Project state: clips, selections, locks, cached measurements.

Design points that the requirements hinge on:

* Measurements are cached against a *selection signature* plus the source
  fingerprint.  Redrawing a range invalidates that clip's measurement only.
* A locked clip stores its own gain and peak-ceiling settings; recomputing
  against a new reference selection never writes over them.  Unlocking
  explicitly hands control back to the reference.
* A reopened project compares each stored source snapshot with the file on
  disk.  If the bytes changed (same name, different content included) the
  clip's measurements and last render check are dropped, and the clip is
  flagged so the UI asks for a re-match instead of silently reusing old
  numbers.
"""

from __future__ import annotations

import json
import math
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np

from .audio_io import (
    AudioClip,
    SourceChange,
    SourceSnapshot,
    detect_source_changes,
    fingerprint_file,
    load_audio,
)
from .levels import (
    Interval,
    Region,
    SelectionMeasurement,
    merge_intervals,
    regions_to_intervals,
    summarize_warning,
)

PROJECT_VERSION = 2


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass
class ClipState:
    """Everything the app knows about one imported recording."""

    id: str
    path: str
    name: str
    source: SourceSnapshot
    sample_rate: int
    frames: int
    regions: list[Region] = field(default_factory=list)

    # A locked clip keeps its own settings when the reference changes.
    locked: bool = False
    locked_gain_db: float | None = None
    locked_ceiling_enabled: bool = False
    locked_ceiling_db: float | None = None
    locked_mode: str | None = None

    # Peak ceiling is per-clip and independent of the lock: a user can keep a
    # safety ceiling while letting the level follow the reference.
    peak_limit_enabled: bool = False
    peak_limit_db: float = -1.0
    # "headroom" lowers the whole gain to fit; "limiter" keeps the level and
    # reports every time range it had to touch.
    peak_mode: str = "headroom"

    # Cached, signature-keyed measurement.  At most one is "current".
    measurement: SelectionMeasurement | None = None
    measurement_signature: str | None = None
    last_render_check: dict | None = None
    needs_rematch: bool = False

    def speech_regions(self) -> list[Interval]:
        return regions_to_intervals(self.regions, "speech")

    def exclude_regions(self) -> list[Interval]:
        return regions_to_intervals(self.regions, "exclude")

    @property
    def ceiling_db(self) -> float | None:
        if self.peak_limit_enabled:
            return float(self.peak_limit_db)
        return None

    def effective_ceiling(self) -> float | None:
        """Locked clips may carry their own ceiling, which wins when set."""
        if self.locked and self.locked_ceiling_enabled:
            return float(self.locked_ceiling_db) if self.locked_ceiling_db is not None else -1.0
        return self.ceiling_db

    def effective_mode(self) -> str:
        """Peak strategy in force; a lock can freeze it with the gain."""
        if self.locked and self.locked_mode:
            return self.locked_mode
        return self.peak_mode

    def selection_signature(self) -> str:
        """Changes exactly when the persisted selection or source changes."""
        payload = {
            "source": self.source.fingerprint,
            "rate": self.sample_rate,
            "regions": [
                (r.kind, r.start, r.end)
                for r in sorted(self.regions, key=lambda r: (r.start, r.end, r.kind))
            ],
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))

    def mark_measurement(self, measurement: SelectionMeasurement) -> None:
        self.measurement = measurement
        self.measurement_signature = self.selection_signature()

    def clear_measurement(self, reason: str = "") -> None:
        self.measurement = None
        self.measurement_signature = None
        self.last_render_check = None
        if reason:
            self.needs_rematch = True

    def invalidate_if_stale(self) -> bool:
        if self.measurement is None:
            return False
        if self.measurement_signature != self.selection_signature():
            self.measurement = None
            self.measurement_signature = None
            self.last_render_check = None
            return True
        return False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "path": self.path,
            "name": self.name,
            "source": self.source.to_dict(),
            "sample_rate": self.sample_rate,
            "frames": self.frames,
            "regions": [r.to_dict() for r in self.regions],
            "locked": self.locked,
            "locked_gain_db": self.locked_gain_db,
            "locked_ceiling_enabled": self.locked_ceiling_enabled,
            "locked_ceiling_db": self.locked_ceiling_db,
            "peak_limit_enabled": self.peak_limit_enabled,
            "peak_limit_db": self.peak_limit_db,
            "peak_mode": self.peak_mode,
            "locked_mode": self.locked_mode,
            "measurement": self.measurement.to_dict() if self.measurement else None,
            "measurement_signature": self.measurement_signature,
            "last_render_check": self.last_render_check,
            "needs_rematch": self.needs_rematch,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ClipState":
        source = SourceSnapshot.from_dict(data.get("source", {}))
        measurement = None
        stored_signature = data.get("measurement_signature")
        if data.get("measurement"):
            measurement = SelectionMeasurement.from_dict(
                data["measurement"], sample_rate=float(data.get("sample_rate", 0))
            )
        clip = cls(
            id=str(data.get("id") or _new_id()),
            path=str(data.get("path", "")),
            name=str(data.get("name", Path(str(data.get("path", ""))).name)),
            source=source,
            sample_rate=int(data.get("sample_rate", 0)),
            frames=int(data.get("frames", 0)),
            regions=[Region.from_dict(r) for r in data.get("regions", [])],
            locked=bool(data.get("locked", False)),
            locked_gain_db=_opt_float(data.get("locked_gain_db")),
            locked_ceiling_enabled=bool(data.get("locked_ceiling_enabled", False)),
            locked_ceiling_db=_opt_float(data.get("locked_ceiling_db")),
            peak_limit_enabled=bool(data.get("peak_limit_enabled", False)),
            peak_limit_db=float(data.get("peak_limit_db", -1.0)),
            peak_mode=str(data.get("peak_mode", "headroom")),
            locked_mode=(str(data["locked_mode"]) if data.get("locked_mode") else None),
            measurement=measurement,
            measurement_signature=stored_signature,
            last_render_check=data.get("last_render_check"),
            needs_rematch=bool(data.get("needs_rematch", False)),
        )
        # A stored measurement whose signature no longer matches the stored
        # selection is stale even before the source is checked.
        if measurement is not None and stored_signature != clip.selection_signature():
            clip.measurement = None
            clip.measurement_signature = None
            clip.last_render_check = None
        return clip


def _opt_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


@dataclass
class Project:
    """Serializable app state."""

    clips: list[ClipState] = field(default_factory=list)
    reference_clip_id: str | None = None
    target_override_db: float | None = None
    output_dir: str | None = None
    path: str | None = None
    dirty: bool = False

    # ------------------------------------------------------------------ clips

    def add_clip(self, clip: AudioClip) -> ClipState:
        existing = self.find_by_path(clip.path)
        if existing is not None:
            return existing
        state = ClipState(
            id=_new_id(),
            path=clip.path,
            name=Path(clip.path).name,
            source=SourceSnapshot(
                path=clip.path,
                fingerprint=clip.fingerprint,
                file_size=clip.file_size,
                file_mtime_ns=clip.file_mtime_ns,
            ),
            sample_rate=clip.sample_rate,
            frames=clip.frames,
        )
        self.clips.append(state)
        self.dirty = True
        if self.reference_clip_id is None:
            self.reference_clip_id = state.id
            # Sensible default: the first loud phrase becomes the reference
            # selection; the user refines it.
            state.regions = self._default_regions(clip)
        return state

    @staticmethod
    def _default_regions(clip: AudioClip) -> list[Region]:
        # Use the most energetic 1 s window as the starting reference so it is
        # not a guess at the waveform's middle.
        rate = clip.sample_rate
        window = min(clip.frames, int(1.0 * rate))
        if window <= 0:
            return []
        best_start, best_energy = 0, -1.0
        step = max(1, int(0.05 * rate))
        for start in range(0, max(1, clip.frames - window + 1), step):
            segment = clip.samples[start : start + window]
            energy = float(np.mean(np.square(segment))) if segment.size else 0.0
            if energy > best_energy:
                best_start, best_energy = start, energy
        return [Region("speech", best_start, min(clip.frames, best_start + window))]

    def remove_clip(self, clip_id: str) -> None:
        self.clips = [c for c in self.clips if c.id != clip_id]
        if self.reference_clip_id == clip_id:
            self.reference_clip_id = self.clips[0].id if self.clips else None
        self.dirty = True

    def find(self, clip_id: str) -> ClipState | None:
        for clip in self.clips:
            if clip.id == clip_id:
                return clip
        return None

    def find_by_path(self, path: str) -> ClipState | None:
        target = str(Path(path).expanduser().resolve())
        for clip in self.clips:
            if str(Path(clip.path).expanduser().resolve()) == target:
                return clip
        return None

    @property
    def reference_clip(self) -> ClipState | None:
        return self.find(self.reference_clip_id) if self.reference_clip_id else None

    def set_reference(self, clip_id: str) -> None:
        if self.find(clip_id) is not None:
            self.reference_clip_id = clip_id
            self.dirty = True

    # -------------------------------------------------------------- selection

    def add_region(self, clip_id: str, kind: str, start: int, end: int) -> Region | None:
        clip = self.find(clip_id)
        if clip is None:
            return None
        start = max(0, min(int(start), clip.frames))
        end = max(0, min(int(end), clip.frames))
        if end <= start:
            return None
        region = Region(kind=kind, start=start, end=end)
        clip.regions.append(region)
        clip.invalidate_if_stale()
        self.dirty = True
        return region

    def replace_regions(self, clip_id: str, regions: Iterable[Region]) -> None:
        clip = self.find(clip_id)
        if clip is None:
            return
        clip.regions = list(regions)
        clip.invalidate_if_stale()
        self.dirty = True

    def clear_regions(self, clip_id: str, kind: str | None = None) -> None:
        clip = self.find(clip_id)
        if clip is None:
            return
        if kind is None:
            clip.regions.clear()
        else:
            clip.regions = [r for r in clip.regions if r.kind != kind]
        clip.invalidate_if_stale()
        self.dirty = True

    # ------------------------------------------------------------------ locks

    def set_locked(
        self,
        clip_id: str,
        locked: bool,
        gain_db: float | None = None,
        ceiling_enabled: bool | None = None,
        ceiling_db: float | None = None,
        mode: str | None = None,
    ) -> None:
        """Lock/unlock a clip without ever overwriting settings on lock.

        Locking captures the current effective numbers when the caller does
        not supply them; unlocking clears the captured gain so the clip follows
        the reference again.
        """
        clip = self.find(clip_id)
        if clip is None:
            return
        clip.locked = bool(locked)
        if locked:
            if gain_db is not None:
                clip.locked_gain_db = float(gain_db)
            elif clip.locked_gain_db is None:
                # Keep whatever is currently computed; the engine fills this
                # in on the next match if it is still None.
                clip.locked_gain_db = None
            clip.locked_ceiling_enabled = (
                clip.peak_limit_enabled if ceiling_enabled is None else bool(ceiling_enabled)
            )
            if clip.locked_ceiling_enabled:
                clip.locked_ceiling_db = (
                    float(ceiling_db) if ceiling_db is not None else clip.peak_limit_db
                )
            clip.locked_mode = str(mode) if mode is not None else clip.peak_mode
        else:
            clip.locked_gain_db = None
            clip.locked_ceiling_enabled = False
            clip.locked_ceiling_db = None
            clip.locked_mode = None
        self.dirty = True

    def capture_lock_values(self, clip_id: str, gain_db: float | None) -> None:
        """Store computed values into an already-locked clip exactly once."""
        clip = self.find(clip_id)
        if clip is None or not clip.locked:
            return
        if clip.locked_gain_db is None and gain_db is not None:
            clip.locked_gain_db = float(gain_db)
        if clip.locked_ceiling_enabled and clip.locked_ceiling_db is None:
            clip.locked_ceiling_db = clip.peak_limit_db
        if clip.locked_mode is None:
            clip.locked_mode = clip.peak_mode

    # ----------------------------------------------------------------- target

    def target_db(self, reference_measurement: SelectionMeasurement | None) -> float | None:
        if self.target_override_db is not None:
            return self.target_override_db
        if reference_measurement is not None:
            return reference_measurement.rms_db
        return None

    def reset_target(self) -> None:
        self.target_override_db = None
        self.dirty = True

    def set_target(self, value: float | None) -> None:
        self.target_override_db = None if value is None else float(value)
        self.dirty = True

    # --------------------------------------------------------------- sources

    def check_sources(self) -> dict[str, SourceChange]:
        """Compare stored source identity with disk; clear stale measurements.

        Called on project open (explicitly) and on a reload action.  The
        caller shows the returned changes to the user and offers a re-match.
        """
        snapshots = {clip.id: clip.source for clip in self.clips}
        changes = detect_source_changes(snapshots)
        for clip_id, change in changes.items():
            clip = self.find(clip_id)
            if clip is None:
                continue
            clip.clear_measurement(reason=change.reason)
            clip.needs_rematch = True
            # Keep the path so the user can relink, but the old bytes' numbers
            # must not survive.
            if change.reason == "missing":
                clip.frames = 0
        if changes:
            self.dirty = True
        return changes

    def adopt_source(self, clip_id: str, clip: AudioClip) -> None:
        """Point a clip at freshly loaded content and clear its old numbers."""
        state = self.find(clip_id)
        if state is None:
            return
        state.path = clip.path
        state.name = Path(clip.path).name
        state.source = SourceSnapshot(
            path=clip.path,
            fingerprint=clip.fingerprint,
            file_size=clip.file_size,
            file_mtime_ns=clip.file_mtime_ns,
        )
        state.sample_rate = clip.sample_rate
        state.frames = clip.frames
        # Regions are sample offsets, so clamping keeps them usable when the
        # new file is shorter; the measurements are still discarded.
        for region in state.regions:
            region.start = max(0, min(region.start, clip.frames))
            region.end = max(0, min(region.end, clip.frames))
        state.regions = [r for r in state.regions if r.end > r.start]
        state.clear_measurement(reason="changed")
        state.needs_rematch = True
        self.dirty = True

    def import_paths(self, paths: Iterable[str]) -> tuple[list[ClipState], list[tuple[str, str]]]:
        added: list[ClipState] = []
        errors: list[tuple[str, str]] = []
        for path in paths:
            try:
                clip = load_audio(path)
            except Exception as exc:  # surfaced to the user, not swallowed
                errors.append((str(path), str(exc)))
                continue
            existing = self.find_by_path(clip.path)
            if existing is not None:
                added.append(existing)
                continue
            added.append(self.add_clip(clip))
        return added, errors

    # ------------------------------------------------------------ serialization

    def to_dict(self) -> dict:
        return {
            "app": "interview-loudness-matcher",
            "version": PROJECT_VERSION,
            "reference_clip_id": self.reference_clip_id,
            "target_override_db": self.target_override_db,
            "output_dir": self.output_dir,
            "clips": [clip.to_dict() for clip in self.clips],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Project":
        if int(data.get("version", 0)) > PROJECT_VERSION:
            raise ValueError("项目文件版本比程序新，请升级程序")
        project = cls(
            clips=[ClipState.from_dict(item) for item in data.get("clips", [])],
            reference_clip_id=data.get("reference_clip_id"),
            target_override_db=_opt_float(data.get("target_override_db")),
            output_dir=data.get("output_dir"),
        )
        if project.reference_clip_id and project.find(project.reference_clip_id) is None:
            project.reference_clip_id = project.clips[0].id if project.clips else None
        return project

    def save(self, path: str | Path | None = None) -> Path:
        target = Path(path or self.path or "interview_match.project.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = self.to_dict()
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(target)
        self.path = str(target)
        self.dirty = False
        return target

    @classmethod
    def load(cls, path: str | Path) -> "Project":
        source = Path(path)
        data = json.loads(source.read_text(encoding="utf-8"))
        project = cls.from_dict(data)
        project.path = str(source)
        return project


def selection_warning_texts(measurement: SelectionMeasurement | None) -> list[str]:
    if measurement is None:
        return []
    return [summarize_warning(code) for code in measurement.warning_codes]


def selection_intervals_for_display(
    clip: ClipState,
) -> tuple[list[Interval], list[Interval]]:
    """Effective kept intervals and excluded intervals, for the mini-map."""
    speech = merge_intervals(clip.speech_regions())
    exclude = merge_intervals(clip.exclude_regions())
    from .levels import subtract_intervals

    return subtract_intervals(speech, exclude), exclude


def source_fingerprint_now(clip: ClipState) -> str | None:
    try:
        return fingerprint_file(clip.path)
    except OSError:
        return None
