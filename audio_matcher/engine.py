"""End-to-end matching pass: measure, solve, write, re-measure, report.

This module is UI-free on purpose so the exact same code path can be driven by
the desktop app and by the headless verification command.  If the verification
command only worked on a parallel implementation, it would not verify anything.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np

from .audio_io import load_audio, write_wav
from .levels import (
    Interval,
    SelectionMeasurement,
    measure_selection,
    selection_provenance_text,
    subtract_intervals,
    summarize_warning,
)
from .matching import (
    GainPlan,
    PEAK_MODE_HEADROOM,
    render_samples,
    solve_gain,
    suggested_target,
    verify_render,
)
from .project import ClipState, Project

DEFAULT_TARGET_RMS_DB = -20.0
DEFAULT_CEILING_DB = -1.0


@dataclass
class ClipEvaluation:
    """Everything decided for one clip in one pass."""

    clip: ClipState
    measurement: SelectionMeasurement | None
    plan: GainPlan | None
    note: str = ""

    @property
    def usable(self) -> bool:
        return self.measurement is not None and self.plan is not None

    @property
    def blocked_reason(self) -> str:
        if self.clip.needs_rematch:
            return "源文件已变更，需重新匹配"
        if self.measurement is None:
            return "未测量"
        if self.measurement.silent:
            return "选区内没有可用语音"
        if self.measurement.too_short:
            return "有效选区太短"
        if self.plan is None:
            return "缺少参考目标"
        return self.note

    @property
    def limited(self) -> bool:
        return self.plan is not None and self.plan.limited

    @property
    def shortfall_db(self) -> float:
        return self.plan.shortfall_db if self.plan else 0.0


@dataclass
class MatchOutcome:
    evaluations: list[ClipEvaluation]
    reference_id: str | None
    target_rms_db: float | None
    suggested_target_db: float | None
    output_dir: str | None
    report_paths: dict[str, str] = field(default_factory=dict)

    def by_clip(self) -> dict[str, ClipEvaluation]:
        return {item.clip.id: item for item in self.evaluations}


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------


def effective_intervals(clip: ClipState) -> tuple[list[Interval], list[Interval]]:
    """Speech union minus exclude union, as disjoint intervals."""
    from .levels import merge_intervals, regions_to_intervals

    speech = merge_intervals(regions_to_intervals(clip.regions, "speech"))
    exclude = merge_intervals(regions_to_intervals(clip.regions, "exclude"))
    return subtract_intervals(speech, exclude), exclude


def measure_clip(clip: ClipState, audio: np.ndarray) -> SelectionMeasurement:
    speech, exclude = effective_intervals(clip)
    return measure_selection(audio, clip.sample_rate, speech, exclude)


def evaluate(
    project: Project,
    audio: dict[str, np.ndarray],
    target_rms_db: float | None = None,
    force_measure: bool = False,
    refresh_needs_rematch: bool = False,
) -> MatchOutcome:
    """Measure every clip, then derive gains from the shared target.

    The target defaults to the reference clip's measured active-speech level
    unless the project carries an override.  A clip that is locked keeps its
    stored gain and ceiling regardless of the current target.

    ``refresh_needs_rematch`` is set by an explicit "re-match" action: it
    clears the stale-source flag once a fresh measurement succeeds.  Passive
    recomputation (changing the reference, a target edit) leaves the flag
    alone, because an automatic pass is not the re-match the user was asked
    to confirm.
    """
    reference = project.reference_clip
    reference_measurement: SelectionMeasurement | None = None
    if (
        reference is not None
        and reference.id in audio
        and (not reference.needs_rematch or refresh_needs_rematch)
    ):
        # A stored measurement whose selection changed must not become the
        # target again just because it happens to be cached.
        reference.invalidate_if_stale()
        if reference.measurement is not None and not force_measure:
            reference_measurement = reference.measurement
        else:
            reference_measurement = measure_clip(reference, audio[reference.id])
            reference.mark_measurement(reference_measurement)

    target = target_rms_db
    if target is None:
        target = project.target_db(reference_measurement)

    plans: dict[str, GainPlan | None] = {}
    evaluations: list[ClipEvaluation] = []
    for clip in project.clips:
        samples = audio.get(clip.id)
        if samples is None:
            evaluations.append(ClipEvaluation(clip, clip.measurement, None, "音频未加载"))
            plans[clip.id] = None
            continue
        if clip.needs_rematch and not refresh_needs_rematch:
            # The bytes changed since the project was saved.  Do not quietly
            # produce numbers for the new content: the user was asked to
            # confirm the selection and press "重新匹配" first.
            plans[clip.id] = None
            evaluations.append(
                ClipEvaluation(clip, None, None, "源文件已变更，需重新匹配")
            )
            continue
        if clip.measurement is None or force_measure or clip.invalidate_if_stale():
            clip.mark_measurement(measure_clip(clip, samples))
        measurement = clip.measurement
        if clip.locked:
            # A locked clip never follows the reference target.  When no gain
            # was captured yet (e.g. locked before the first match), 0 dB is
            # the honest default: leave the clip as recorded rather than
            # invent a level from its own measurement.
            gain = clip.locked_gain_db if clip.locked_gain_db is not None else 0.0
            plan = GainPlan(
                # Keep the strategy captured with the lock, so a locked
                # limiter clip still reports the ranges it changes on export.
                mode=clip.effective_mode(),
                match_gain_db=gain,
                applied_gain_db=gain,
                predicted_rms_db=(measurement.rms_db + gain) if measurement.rms_db is not None else None,
                predicted_peak_db=(
                    measurement.clip_peak_db + gain
                    if measurement.clip_peak_db is not None
                    else None
                ),
                limited=False,
                shortfall_db=0.0,
                headroom_db=None,
            )
            evaluations.append(ClipEvaluation(clip, measurement, plan, "已锁定"))
            plans[clip.id] = plan
            continue
        mode = clip.effective_mode()
        ceiling = clip.ceiling_db
        plan = solve_gain(
            measurement.rms_db if measurement else None,
            measurement.clip_peak_db if measurement else None,
            target,
            ceiling,
            mode=mode,
        )
        plans[clip.id] = plan
        evaluations.append(ClipEvaluation(clip, measurement, plan))

    if refresh_needs_rematch:
        for item in evaluations:
            clip = item.clip
            if clip.needs_rematch and item.measurement is not None:
                # The explicit re-match succeeded against the current bytes.
                clip.needs_rematch = False
    suggestion = suggested_target(plans, target)
    return MatchOutcome(
        evaluations=evaluations,
        reference_id=reference.id if reference else None,
        target_rms_db=target,
        suggested_target_db=suggestion,
        output_dir=project.output_dir,
    )


# ---------------------------------------------------------------------------
# Render + export
# ---------------------------------------------------------------------------


@dataclass
class ExportRecord:
    clip_id: str
    clip_name: str
    source_path: str
    output_path: str | None
    gain_db: float | None
    mode: str
    target_rms_db: float | None
    source_rms_db: float | None
    measured_rms_db: float | None
    source_peak_db: float | None
    output_peak_db: float | None
    deviation_db: float | None
    status: str
    note: str
    warnings: list[str]
    provenance: list[dict]
    limited_runs: list[dict]
    selection_duration_s: float
    active_s: float

    def to_dict(self) -> dict:
        return {
            "clip_id": self.clip_id,
            "clip_name": self.clip_name,
            "source_path": self.source_path,
            "output_path": self.output_path,
            "gain_db": _round(self.gain_db),
            "mode": self.mode,
            "target_rms_db": _round(self.target_rms_db),
            "source_rms_db": _round(self.source_rms_db),
            "measured_rms_db": _round(self.measured_rms_db),
            "source_peak_db": _round(self.source_peak_db),
            "output_peak_db": _round(self.output_peak_db),
            "deviation_db": _round(self.deviation_db),
            "status": self.status,
            "note": self.note,
            "warnings": list(self.warnings),
            "provenance": list(self.provenance),
            "limited_runs": list(self.limited_runs),
            "selection_duration_s": round(self.selection_duration_s, 4),
            "active_s": round(self.active_s, 4),
        }


def _round(value: float | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return round(float(value), 3)


def export_clip(
    clip: ClipState,
    samples: np.ndarray,
    output_dir: Path,
    target_rms_db: float | None,
    evaluation: ClipEvaluation,
) -> tuple[ExportRecord, np.ndarray | None]:
    """Render one clip, write it, then re-measure the bytes written.

    Returns the record and the rendered samples (``None`` when the clip could
    not be rendered), so the caller can keep the rendered audio for playback.
    """
    speech, exclude = effective_intervals(clip)
    measurement = evaluation.measurement
    warnings = (
        [summarize_warning(code) for code in measurement.warning_codes]
        if measurement
        else []
    )
    base = {
        "clip_id": clip.id,
        "clip_name": clip.name,
        "source_path": clip.path,
        "selection_duration_s": measurement.total_duration_s if measurement else 0.0,
        "active_s": measurement.active_s if measurement else 0.0,
        "provenance": measurement.provenance if measurement else [],
        "warnings": warnings,
    }
    if evaluation.plan is None or measurement is None:
        return (
            ExportRecord(
                output_path=None,
                gain_db=None,
                mode=PEAK_MODE_HEADROOM,
                target_rms_db=target_rms_db,
                source_rms_db=measurement.rms_db if measurement else None,
                measured_rms_db=measurement.rms_db if measurement else None,
                source_peak_db=measurement.clip_peak_db if measurement else None,
                output_peak_db=None,
                deviation_db=None,
                status="skipped",
                note=evaluation.blocked_reason,
                limited_runs=[],
                **base,
            ),
            None,
        )
    plan = evaluation.plan
    ceiling = clip.effective_ceiling()
    rendered = render_samples(
        samples,
        clip.sample_rate,
        plan.applied_gain_db,
        ceiling,
        mode=plan.mode,
    )
    output_path = output_dir / f"matched_{Path(clip.name).stem}.wav"
    write_wav(output_path, rendered.samples, clip.sample_rate)

    # Read the file back: this catches a writer/subtype problem as well as
    # proving the numbers below describe the deliverable.
    written = load_audio(output_path)
    check = verify_render(
        written.samples,
        written.sample_rate,
        speech,
        exclude,
        target_rms_db,
    )
    status = "ok"
    note = ""
    if evaluation.limited and plan.mode == PEAK_MODE_HEADROOM:
        status = "below_target"
        note = f"峰值限制使增益少了 {plan.shortfall_db:.1f} dB，未能达到目标"
        if check.deviation_db is not None:
            note += f"；成品实测偏差 {check.deviation_db:+.2f} dB"
    elif check.deviates_from_target and check.deviation_db is not None:
        status = "deviates"
        direction = "高于" if check.deviation_db > 0 else "低于"
        note = f"成品实测{direction}目标 {abs(check.deviation_db):.2f} dB"
    record = ExportRecord(
        output_path=str(output_path),
        gain_db=plan.applied_gain_db,
        mode=plan.mode,
        target_rms_db=target_rms_db,
        source_rms_db=measurement.rms_db,
        measured_rms_db=check.measured_rms_db,
        source_peak_db=measurement.clip_peak_db,
        output_peak_db=check.measured_peak_db,
        deviation_db=check.deviation_db,
        status=status,
        note=note,
        limited_runs=[run.to_dict() for run in rendered.limited_runs],
        **base,
    )
    if rendered.limited_runs:
        loudest_source_peak = max(
            (run.peak_db - run.reduction_db) for run in rendered.limited_runs
        )
        record.warnings = warnings + [
            f"峰值限制改变了 {len(rendered.limited_runs)} 处时间区间"
            f"（源峰值最高 {loudest_source_peak:.2f} dBFS）"
        ]
    return record, rendered.samples


def export_all(
    project: Project,
    outcome: MatchOutcome,
    audio: dict[str, np.ndarray],
    output_dir: str | Path | None = None,
) -> dict:
    """Write every clip and both reports; returns a summary dict."""
    target_dir = Path(output_dir or outcome.output_dir or "output")
    target_dir.mkdir(parents=True, exist_ok=True)
    records: list[ExportRecord] = []
    rendered: dict[str, np.ndarray] = {}
    for evaluation in outcome.evaluations:
        samples = audio.get(evaluation.clip.id)
        if samples is None:
            records.append(
                ExportRecord(
                    clip_id=evaluation.clip.id,
                    clip_name=evaluation.clip.name,
                    source_path=evaluation.clip.path,
                    output_path=None,
                    gain_db=None,
                    mode=PEAK_MODE_HEADROOM,
                    target_rms_db=outcome.target_rms_db,
                    source_rms_db=None,
                    measured_rms_db=None,
                    source_peak_db=None,
                    output_peak_db=None,
                    deviation_db=None,
                    status="skipped",
                    note="音频未加载",
                    warnings=[],
                    provenance=[],
                    limited_runs=[],
                    selection_duration_s=0.0,
                    active_s=0.0,
                )
            )
            continue
        record, samples_out = export_clip(
            evaluation.clip,
            samples,
            target_dir,
            outcome.target_rms_db,
            evaluation,
        )
        records.append(record)
        if samples_out is not None:
            rendered[evaluation.clip.id] = samples_out
        # Persist the result check so a reopened project shows the last known
        # state of the deliverable, not just the source measurement.
        evaluation.clip.last_render_check = record.to_dict()

    report_json = target_dir / "match_report.json"
    report_csv = target_dir / "match_report.csv"
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target_rms_db": _round(outcome.target_rms_db),
        "suggested_target_db": _round(outcome.suggested_target_db),
        "reference_clip_id": outcome.reference_id,
        "clips": [record.to_dict() for record in records],
    }
    report_json.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _write_csv(report_csv, records)
    return {
        "output_dir": str(target_dir),
        "records": records,
        "rendered": rendered,
        "report_json": str(report_json),
        "report_csv": str(report_csv),
    }


CSV_FIELDS = [
    "clip_name",
    "source_path",
    "output_path",
    "status",
    "mode",
    "gain_db",
    "target_rms_db",
    "source_rms_db",
    "measured_rms_db",
    "deviation_db",
    "source_peak_db",
    "output_peak_db",
    "selection_duration_s",
    "active_s",
    "provenance_text",
    "warnings_text",
    "limited_runs_text",
    "note",
]


def _write_csv(path: Path, records: Iterable[ExportRecord]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for record in records:
            data = record.to_dict()
            prov = "；".join(
                f'{item["start_s"]:.2f}-{item["end_s"]:.2f}s'
                f' ({item["share"] * 100:.0f}%)'
                for item in record.provenance
            )
            runs = "；".join(
                f'{run["start_s"]:.3f}-{run["end_s"]:.3f}s '
                f'({run["reduction_db"]:.1f} dB)'
                for run in record.limited_runs
            )
            writer.writerow(
                {
                    "clip_name": record.clip_name,
                    "source_path": record.source_path,
                    "output_path": record.output_path or "",
                    "status": record.status,
                    "mode": record.mode,
                    "gain_db": _csv_num(data["gain_db"]),
                    "target_rms_db": _csv_num(data["target_rms_db"]),
                    "source_rms_db": _csv_num(data["source_rms_db"]),
                    "measured_rms_db": _csv_num(data["measured_rms_db"]),
                    "deviation_db": _csv_num(data["deviation_db"]),
                    "source_peak_db": _csv_num(data["source_peak_db"]),
                    "output_peak_db": _csv_num(data["output_peak_db"]),
                    "selection_duration_s": f"{record.selection_duration_s:.3f}",
                    "active_s": f"{record.active_s:.3f}",
                    "provenance_text": prov,
                    "warnings_text": "；".join(record.warnings),
                    "limited_runs_text": runs,
                    "note": record.note,
                }
            )


def _csv_num(value: float | None) -> str:
    return "" if value is None else f"{value:.3f}"


def provenance_summary(measurement: SelectionMeasurement | None) -> str:
    if measurement is None:
        return "未测量"
    return selection_provenance_text(measurement)
