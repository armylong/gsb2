"""Document model: one file, its clip segments, repair records and export checks.

This is deliberately Qt-free.  The window is a thin view over this object, and
the tests drive the same code paths the UI uses.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import analysis as an
from .analysis import (
    CONFIDENCE_LABELS,
    METHOD_LABELS,
    STATUS_CONFIRMED,
    STATUS_EXCLUDED,
    STATUS_SUSPECTED,
    DetectionConfig,
    RepairRecord,
    Segment,
)
from .samples import SAMPLES, ensure_samples
from .wavio import WavData, load_wav


@dataclass
class SegmentView:
    segment: Segment
    record: RepairRecord | None

    @property
    def enabled(self) -> bool:
        return self.segment.status != STATUS_EXCLUDED

    @property
    def confidence_label(self) -> str:
        if self.record is None:
            return "—"
        return CONFIDENCE_LABELS.get(self.record.confidence, "—")

    @property
    def hint(self) -> str:
        parts: list[str] = []
        if self.segment.hint:
            parts.append(self.segment.hint)
        if self.record:
            parts.extend(self.record.flags)
        return "；".join(dict.fromkeys(parts))


class Document:
    def __init__(self) -> None:
        self.wav: WavData | None = None
        self.name: str = ""
        self.sample_key: str | None = None
        self.config = DetectionConfig()
        self.segments: list[Segment] = []
        self.method: str = "auto"
        self.records: list[RepairRecord] = []
        self.repaired: np.ndarray | None = None
        self._next_uid = 1

    # -- loading -----------------------------------------------------------

    def load(self, path: str | Path) -> None:
        wav = load_wav(path)
        self._adopt(wav, name=str(path), sample_key=None)

    def load_sample(self, key: str, directory: str | Path) -> None:
        paths = ensure_samples(directory)
        if key not in paths:
            raise KeyError(key)
        title = next((s.title for s in SAMPLES if s.key == key), key)
        self._adopt(load_wav(paths[key]), name=f"内置样例 · {title}", sample_key=key)

    def _adopt(self, wav: WavData, name: str, sample_key: str | None) -> None:
        self.wav = wav
        self.name = name
        self.sample_key = sample_key
        self._next_uid = 1
        self.segments = []
        self.records = []
        self.repaired = None
        self.redetect()

    # -- detection ---------------------------------------------------------

    def _mint_uid(self) -> int:
        uid = self._next_uid
        self._next_uid += 1
        return uid

    def redetect(self) -> None:
        """Re-run detection at the current thresholds.

        Confirmed and excluded segments are pinned: they survive even when the
        new threshold no longer finds them, and their interval is unioned with
        anything newly detected underneath it.
        """
        if self.wav is None:
            return
        previous = [s.copy() for s in self.segments]
        detected = an.detect_segments(
            self.wav.samples, self.wav.sample_rate, self.config, previous
        )
        for seg in detected:
            if seg.uid == 0:
                seg.uid = self._mint_uid()
        self.segments = detected
        self.rebuild()

    def set_thresholds(
        self,
        pos_dbfs: float,
        neg_dbfs: float,
        min_run: int,
        join_gap: int,
    ) -> None:
        self.config = DetectionConfig(
            pos_dbfs=pos_dbfs,
            neg_dbfs=neg_dbfs,
            min_run=max(1, int(min_run)),
            join_gap=max(0, int(join_gap)),
        )
        self.redetect()

    # -- segment decisions -------------------------------------------------

    def segment(self, uid: int) -> Segment | None:
        return next((s for s in self.segments if s.uid == uid), None)

    def set_status(self, uid: int, status: str) -> None:
        seg = self.segment(uid)
        if seg is None:
            return
        if status not in (STATUS_SUSPECTED, STATUS_CONFIRMED, STATUS_EXCLUDED):
            raise ValueError(status)
        seg.status = status
        seg.source = "user"
        self.rebuild()

    def set_enabled(self, uid: int, enabled: bool) -> None:
        """Checkbox semantics: checked keeps repairing, unchecked excludes.

        Unchecking never deletes the row: the segment stays visible as
        "excluded" so the decision is auditable.
        """
        seg = self.segment(uid)
        if seg is None:
            return
        if enabled:
            if seg.status == STATUS_EXCLUDED:
                self.set_status(uid, STATUS_CONFIRMED)
        else:
            self.set_status(uid, STATUS_EXCLUDED)

    def add_user_region(
        self,
        channel: int,
        start: int,
        end: int,
        polarity: int = 1,
        status: str = STATUS_CONFIRMED,
    ) -> Segment | None:
        if self.wav is None:
            return None
        start = max(0, min(int(start), self.wav.frames - 1))
        end = max(start + 1, min(int(end), self.wav.frames))
        seg = Segment(
            channel=int(channel),
            polarity=1 if polarity >= 0 else -1,
            start=start,
            end=end,
            status=status,
            source="user",
            hint="手动框选",
            uid=self._mint_uid(),
        )
        # A user region replaces any auto segment fully inside it (the user is
        # explicitly taking over that area), but nearby ones stay listed.
        self.segments = [
            s
            for s in self.segments
            if not (s.channel == seg.channel and seg.start <= s.start and s.end <= seg.end)
        ]
        self.segments.append(seg)
        self.segments.sort(key=lambda s: (s.channel, s.start, s.polarity))
        self.rebuild()
        return seg

    def remove_segment(self, uid: int) -> None:
        self.segments = [s for s in self.segments if s.uid != uid]
        self.rebuild()

    def set_method(self, method: str) -> None:
        self.method = method
        self.rebuild()

    # -- repair ------------------------------------------------------------

    def _clip_masks(self) -> dict[int, np.ndarray]:
        assert self.wav is not None
        masks: dict[int, np.ndarray] = {}
        for ch in range(self.wav.channels):
            masks[ch] = an.segments_to_mask(
                [s for s in self.segments if s.status != STATUS_EXCLUDED],
                ch,
                self.wav.frames,
            )
        return masks

    def rebuild(self) -> None:
        if self.wav is None:
            return
        masks = self._clip_masks()
        records: list[RepairRecord] = []
        for seg in self.segments:
            if seg.status == STATUS_EXCLUDED:
                continue
            records.append(
                an.make_repair_record(
                    self.wav.samples,
                    self.wav.sample_rate,
                    seg,
                    masks[seg.channel],
                    method=self.method,
                )
            )
        self.records = records
        self.repaired = an.apply_repairs(self.wav.samples, records)

    # -- views -------------------------------------------------------------

    def segment_views(self) -> list[SegmentView]:
        by_uid = {r.segment_uid: r for r in self.records}
        return [
            SegmentView(seg, by_uid.get(seg.uid))
            for seg in self.segments
        ]

    def segment_view(self, uid: int) -> SegmentView | None:
        return next(
            (v for v in self.segment_views() if v.segment.uid == uid), None
        )

    @property
    def diff(self) -> np.ndarray | None:
        if self.wav is None or self.repaired is None:
            return None
        return self.repaired - self.wav.samples

    def intended_ranges(self) -> dict[int, list[tuple[int, int]]]:
        assert self.wav is not None
        return an.records_to_change_runs(
            self.records, self.wav.channels, self.wav.frames
        )

    def low_confidence_records(self) -> list[RepairRecord]:
        return [r for r in self.records if r.confidence == an.CONFIDENCE_LOW]

    def changed_frames_mask(self) -> np.ndarray:
        assert self.wav is not None
        mask = np.zeros(self.wav.frames, dtype=bool)
        for rec in self.records:
            for s, e in rec.changed_runs:
                mask[s:e] = True
        return mask

    def total_changed_samples(self) -> int:
        return int(np.count_nonzero(self.changed_frames_mask()))

    # -- export ------------------------------------------------------------

    def headroom(self, bits: int) -> an.HeadroomReport:
        assert self.wav is not None and self.repaired is not None
        return an.headroom_report(self.wav.samples, self.repaired, bits)

    def export(self, path: str | Path, bits: int) -> an.VerificationReport:
        assert self.wav is not None and self.repaired is not None
        an.export_wav(path, self.repaired, self.wav.sample_rate, bits)
        return an.verify_export(
            path,
            self.wav.samples,
            self.repaired,
            bits,
            self.intended_ranges(),
            self.wav.sample_rate,
        )

    # -- audit -------------------------------------------------------------

    def audit(self, verification: an.VerificationReport | None = None) -> dict:
        assert self.wav is not None
        sr = self.wav.sample_rate
        segments = []
        for seg in self.segments:
            view = self.segment_view(seg.uid)
            segments.append(
                {
                    "uid": seg.uid,
                    "channel": seg.channel,
                    "polarity": "positive" if seg.polarity > 0 else "negative",
                    "start_sample": seg.start,
                    "end_sample": seg.end,
                    "start_time": an.format_sample_time(seg.start, sr),
                    "end_time": an.format_sample_time(seg.end, sr),
                    "status": seg.status,
                    "source": seg.source,
                    "repair_enabled": view.enabled if view else False,
                    "hint": view.hint if view else seg.hint,
                }
            )
        records = []
        for rec in self.records:
            records.append(
                {
                    "segment_uid": rec.segment_uid,
                    "channel": rec.channel,
                    "polarity": "positive" if rec.polarity > 0 else "negative",
                    "start_sample": rec.start,
                    "end_sample": rec.end,
                    "method": rec.method,
                    "method_label": METHOD_LABELS.get(rec.method, rec.method),
                    "confidence": rec.confidence,
                    "confidence_label": CONFIDENCE_LABELS[rec.confidence],
                    "flags": list(rec.flags),
                    "changed_sample_runs": [
                        [int(s), int(e)] for s, e in rec.changed_runs
                    ],
                    "changed_sample_count": int(rec.changed_count),
                    "max_delta": float(rec.max_delta),
                }
            )
        out = {
            "source": self.name,
            "sample_rate": sr,
            "channels": self.wav.channels,
            "frames": self.wav.frames,
            "duration_seconds": round(self.wav.duration, 6),
            "detector": {
                "pos_threshold_dbfs": self.config.pos_dbfs,
                "neg_threshold_dbfs": self.config.neg_dbfs,
                "min_run_samples": self.config.min_run,
                "join_gap_samples": self.config.join_gap,
            },
            "repair_method": self.method,
            "segments": segments,
            "repairs": records,
        }
        if verification is not None:
            out["verification"] = {
                "ok": verification.ok,
                "changed_sample_runs": {
                    str(ch): [[int(s), int(e)] for s, e in runs]
                    for ch, runs in verification.changed_runs.items()
                },
                "changed_frames": verification.changed_frames,
                "outside_intended_runs": {
                    str(ch): [[int(s), int(e)] for s, e in runs]
                    for ch, runs in verification.outside_runs.items()
                },
                "outside_intended_frames": verification.outside_frames,
                "max_quant_error_lsb": verification.max_quant_error_lsb,
                "mismatch_frames": verification.mismatch_frames,
            }
        return out

    def write_audit(
        self, path: str | Path, verification: an.VerificationReport | None = None
    ) -> None:
        Path(path).write_text(
            json.dumps(self.audit(verification), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def audit_csv(self) -> str:
        assert self.wav is not None
        sr = self.wav.sample_rate
        lines = [
            "segment_uid,channel,polarity,start_sample,end_sample,start_time,"
            "end_time,status,method,confidence,changed_sample_count,changed_runs"
        ]
        status_by_uid = {s.uid: s.status for s in self.segments}
        for rec in self.records:
            runs = " ".join(f"{s}-{e}" for s, e in rec.changed_runs)
            lines.append(
                f"{rec.segment_uid},{rec.channel},"
                f"{'positive' if rec.polarity > 0 else 'negative'},"
                f"{rec.start},{rec.end},"
                f"{an.format_sample_time(rec.start, sr)},"
                f"{an.format_sample_time(rec.end, sr)},"
                f"{status_by_uid.get(rec.segment_uid, '')},{rec.method},"
                f"{rec.confidence},{rec.changed_count},\"{runs}\""
            )
        return "\n".join(lines) + "\n"


def open_document(path: str | Path) -> Document:
    doc = Document()
    doc.load(path)
    return doc
