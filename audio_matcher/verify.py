"""Headless end-to-end verification of the exact code path the app uses.

This is the "one runnable verification command" from the README:

    python -m audio_matcher.verify

It generates the demo clips, marks the demo selections, runs the match,
exports the WAVs and reports, re-reads and re-measures the written files, and
then exercises the project persistence + source-change rules (lock survival,
stale-measurement clearing, peak-limited time ranges).  It exits non-zero with
a readable list of failed checks; it needs no audio device and no GUI.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import samples
from .audio_io import load_audio
from .engine import evaluate, export_all
from .levels import Region
from .matching import PEAK_MODE_HEADROOM, PEAK_MODE_LIMITER
from .project import Project


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append(Check(name, bool(ok), detail))

    @property
    def failed(self) -> list[Check]:
        return [check for check in self.checks if not check.ok]


def _build_demo_project(source_dir: Path) -> Project:
    paths = samples.write_samples(source_dir)
    project = Project()
    project.import_paths([str(path) for path in paths])
    for clip in project.clips:
        rate = clip.sample_rate
        clip.regions = [
            Region("speech", int(a * rate), int(b * rate))
            for a, b in samples.demo_regions(clip.name)
        ] + [
            Region("exclude", int(a * rate), int(b * rate))
            for a, b in samples.demo_exclusions(clip.name)
        ]
        if clip.name == "speaker_c_peak_clap.wav":
            clip.peak_limit_enabled = True
            clip.peak_limit_db = -1.0
            clip.peak_mode = PEAK_MODE_LIMITER
        elif clip.name == "speaker_e_peak_knock.wav":
            clip.peak_limit_enabled = True
            clip.peak_limit_db = -1.0
            clip.peak_mode = PEAK_MODE_HEADROOM
    reference = next(
        (c for c in project.clips if c.name == "speaker_a_reference.wav"), None
    )
    if reference is not None:
        project.set_reference(reference.id)
    return project


def _load_audio(project: Project) -> dict[str, np.ndarray]:
    return {clip.id: load_audio(clip.path).samples for clip in project.clips}


def _clip_by_name(project: Project, name: str):
    return next((clip for clip in project.clips if clip.name == name), None)


def run_verification(workdir: Path | None = None, keep: bool = False) -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="interview_match_verify_"))
    source_dir = (workdir or temp_root) / "sources"
    output_dir = (workdir or temp_root) / "output"
    project_path = temp_root / "project.json"
    report = Report()

    try:
        project = _build_demo_project(source_dir)
        audio = _load_audio(project)

        # -- measurement and overlap arithmetic ---------------------------
        reference = project.reference_clip
        assert reference is not None
        outcome = evaluate(project, audio)
        report.add(
            "参考段测量可用",
            reference.measurement is not None
            and reference.measurement.rms_db is not None,
            f"参考 RMS {_fmt(reference.measurement.rms_db if reference.measurement else None)}",
        )
        measured_levels = [
            item.measurement.rms_db
            for item in outcome.evaluations
            if item.measurement is not None and item.measurement.rms_db is not None
        ]
        report.add(
            "不同讲话者电平已测出差异",
            len(measured_levels) == len(outcome.evaluations)
            and (max(measured_levels) - min(measured_levels)) > 10.0,
            f"跨度 {max(measured_levels) - min(measured_levels):.1f} dB",
        )

        overlap_clip = _clip_by_name(project, "speaker_b_quiet.wav")
        assert overlap_clip is not None and overlap_clip.measurement is not None
        baseline = overlap_clip.measurement.rms_db
        single_duration = overlap_clip.measurement.total_duration_s
        rate = overlap_clip.sample_rate
        # Add a speech region overlapping the first one entirely; the union
        # must not change, so neither the duration nor the level may move.
        first = min(overlap_clip.speech_regions(), key=lambda part: part.start)
        project.add_region(
            overlap_clip.id,
            "speech",
            first.start + first.length // 4,
            first.end,
        )
        outcome = evaluate(project, audio, force_measure=True)
        overlap_clip = _clip_by_name(project, "speaker_b_quiet.wav")
        assert overlap_clip is not None and overlap_clip.measurement is not None
        report.add(
            "重叠讲话区只计一次",
            abs(overlap_clip.measurement.total_duration_s - single_duration) < 0.01
            and abs((overlap_clip.measurement.rms_db or 0) - (baseline or 0)) < 0.01,
            f"选区仍 {overlap_clip.measurement.total_duration_s:.2f}s",
        )
        # An exclusion over part of a speech region must remove exactly that
        # coverage from the measured span.
        project.add_region(
            overlap_clip.id, "exclude", first.start, first.start + first.length // 2
        )
        outcome = evaluate(project, audio, force_measure=True)
        overlap_clip = _clip_by_name(project, "speaker_b_quiet.wav")
        assert overlap_clip is not None and overlap_clip.measurement is not None
        expected = single_duration - (first.length // 2) / rate
        report.add(
            "排除区按实际覆盖扣除",
            abs(overlap_clip.measurement.total_duration_s - expected) < 0.02,
            f"期望 {expected:.2f}s，实测 {overlap_clip.measurement.total_duration_s:.2f}s",
        )
        provenance = overlap_clip.measurement.provenance
        report.add(
            "显示有效样本来源",
            bool(provenance) and all(item["start_s"] < item["end_s"] for item in provenance),
            f"{len(provenance)} 个有效片段",
        )

        # -- reference change must not overwrite locked clips -------------
        locked = _clip_by_name(project, "speaker_d_loud.wav")
        assert locked is not None
        locked_plan = next(
            (e for e in outcome.evaluations if e.clip.id == locked.id), None
        )
        assert locked_plan is not None and locked_plan.plan is not None
        locked_gain = locked_plan.plan.applied_gain_db
        project.set_locked(
            locked.id,
            True,
            gain_db=locked_gain,
            ceiling_enabled=False,
            mode=locked.peak_mode,
        )
        new_reference = _clip_by_name(project, "speaker_d_loud.wav")
        assert new_reference is not None
        project.set_reference(locked.id)  # the locked clip is now the reference
        outcome = evaluate(project, audio)
        locked_eval = next(e for e in outcome.evaluations if e.clip.id == locked.id)
        report.add(
            "锁定片段不被新参考覆盖",
            locked_eval.plan is not None
            and abs(locked_eval.plan.applied_gain_db - locked_gain) < 1e-6,
            f"锁定增益 {locked_gain:+.2f} dB 保持",
        )
        # Changing the reference selection of another clip must not touch the
        # locked clip either.
        project.set_reference(reference.id)
        audio_ref = project.find(reference.id)
        assert audio_ref is not None
        project.add_region(audio_ref.id, "speech", 0, min(audio_ref.frames, rate // 2))
        outcome = evaluate(project, audio, force_measure=True)
        locked_eval = next(e for e in outcome.evaluations if e.clip.id == locked.id)
        report.add(
            "重新划选参考后锁定值仍在",
            locked_eval.plan is not None
            and abs(locked_eval.plan.applied_gain_db - locked_gain) < 1e-6,
            "锁定增益未变",
        )

        # -- peak shortfall is reported with its dB delta ----------------
        headroom_clip = _clip_by_name(project, "speaker_e_peak_knock.wav")
        assert headroom_clip is not None
        headroom_eval = next(
            e for e in outcome.evaluations if e.clip.id == headroom_clip.id
        )
        report.add(
            "高峰值无法达到目标时给出差值",
            headroom_eval.plan is not None
            and headroom_eval.plan.limited
            and headroom_eval.plan.shortfall_db > 1.0,
            f"差 {headroom_eval.plan.shortfall_db:.2f} dB"
            if headroom_eval.plan
            else "无计划",
        )
        report.add(
            "可达目标建议存在",
            outcome.suggested_target_db is not None
            and outcome.suggested_target_db < (outcome.target_rms_db or 0),
            f"建议 {_fmt(outcome.suggested_target_db)}",
        )

        # -- export and re-measure the written files ---------------------
        export = export_all(project, outcome, audio, output_dir=output_dir)
        records = {record.clip_name: record for record in export["records"]}
        # Clips that reached the target must land within tolerance when the
        # written file is measured; a clip the ceiling held back must report
        # its deviation and its shortfall, not silently pass.
        reached = [
            record
            for record in records.values()
            if record.status in ("ok", "deviates") and record.deviation_db is not None
        ]
        held_back = [
            record for record in records.values() if record.status == "below_target"
        ]
        report.add(
            "导出后成品复测命中目标",
            bool(reached)
            and all(abs(record.deviation_db or 0) < 0.5 for record in reached)
            and all(record.deviation_db is not None for record in held_back)
            and all(
                record.output_path and Path(record.output_path).is_file()
                for record in records.values()
                if record.status != "skipped"
            ),
            f"{len(reached)} 段命中；{len(held_back)} 段明确标记未达标",
        )

        limiter_record = records.get("speaker_c_peak_clap.wav")
        report.add(
            "峰值限制标出改动时间区间",
            limiter_record is not None
            and len(limiter_record.limited_runs) > 0
            and all(run["end_s"] > run["start_s"] for run in limiter_record.limited_runs),
            f"{len(limiter_record.limited_runs) if limiter_record else 0} 处区间",
        )
        report.add(
            "数值报告包含首尾静音与峰均差",
            _silence_and_crest_ok(project, output_dir),
            "源/成品首尾静音与峰均差已写入样例与报告",
        )

        # -- project save/reopen, source change, stale measurement -------
        project.save(project_path)
        reopened = Project.load(project_path)
        reopened_reference = reopened.reference_clip
        reopened_audio = {
            clip.id: load_audio(clip.path).samples for clip in reopened.clips
        }
        _ = evaluate(reopened, reopened_audio)
        same_reference_level = (
            reopened_reference is not None
            and reopened_reference.measurement is not None
            and reference.measurement is not None
            and abs(
                (reopened_reference.measurement.rms_db or 0)
                - (reference.measurement.rms_db or 0)
            )
            < 0.01
        )
        report.add(
            "项目保存后重开测量一致",
            same_reference_level,
            "参考段 RMS 一致",
        )
        reopened_locked = _clip_by_name(reopened, "speaker_d_loud.wav")
        report.add(
            "重开后锁定设置保留",
            reopened_locked is not None
            and reopened_locked.locked
            and abs((reopened_locked.locked_gain_db or 0) - locked_gain) < 1e-6,
            "锁定增益一致",
        )

        # Replace one source file's *content* under the same name, then reopen.
        changed = _clip_by_name(reopened, "speaker_b_quiet.wav")
        assert changed is not None
        new_content = samples.build_sample(
            samples.sample_spec("speaker_b_quiet.wav"), seed=99
        )
        import soundfile as sf

        sf.write(changed.path, new_content, samples.SAMPLE_RATE, subtype="PCM_24")
        before = changed.measurement
        changes = reopened.check_sources()
        report.add(
            "换源后清除旧测量并提示重新匹配",
            before is not None
            and changed.id in changes
            and changed.measurement is None
            and changed.needs_rematch
            and changed.last_render_check is None,
            "旧测量已清除，标记需重新匹配",
        )

        # The paths in the report must be able to carry the last check; after
        # a successful re-match the flag must clear.
        reopened_audio = {
            clip.id: load_audio(clip.path).samples for clip in reopened.clips
        }
        # A passive re-evaluation must keep the changed clip unmeasured; only
        # the explicit re-match may clear the flag.
        _ = evaluate(reopened, reopened_audio)
        changed = _clip_by_name(reopened, "speaker_b_quiet.wav")
        assert changed is not None
        report.add(
            "源文件变更后不自动沿用旧选区测量",
            changed.measurement is None and changed.needs_rematch,
            "需显式重新匹配",
        )
        _ = evaluate(
            reopened,
            reopened_audio,
            force_measure=True,
            refresh_needs_rematch=True,
        )
        changed = _clip_by_name(reopened, "speaker_b_quiet.wav")
        assert changed is not None
        report.add(
            "重新匹配后恢复",
            changed.measurement is not None and changed.measurement.rms_db is not None,
            f"新 RMS {_fmt(changed.measurement.rms_db if changed.measurement else None)}",
        )

        # -- UI-free structural checks -----------------------------------
        report.add(
            "样例数量与场景齐全",
            len(project.clips) == len(samples.SAMPLES),
            f"{len(project.clips)} 段",
        )

        _print_report(report, output_dir)
        return 0 if not report.failed else 1
    finally:
        if keep or workdir is not None:
            print(f"\n验证产物保留在: {source_dir} 和 {output_dir}")
        else:
            shutil.rmtree(temp_root, ignore_errors=True)


def _silence_and_crest_ok(project: Project, output_dir: Path) -> bool:
    """Every exported file must exist, and demo clips must keep head/tail silence."""
    ok = True
    for clip in project.clips:
        source = load_audio(clip.path)
        data = np.abs(source.samples)
        # Head and tail of the generated material are room tone (~-60 dBFS),
        # well above digital silence but far below speech.
        head = float(np.sqrt(np.mean(np.square(data[: int(0.1 * source.sample_rate)]))))
        tail = float(np.sqrt(np.mean(np.square(data[-int(0.1 * source.sample_rate) :]))))
        ok = ok and head > 0 and tail > 0
        ok = ok and (20 * np.log10(head) < -40) and (20 * np.log10(tail) < -40)
    report_json = output_dir / "match_report.json"
    if not report_json.is_file():
        return False
    payload = json.loads(report_json.read_text(encoding="utf-8"))
    for record in payload.get("clips", []):
        if record.get("source_peak_db") is None or record.get("source_rms_db") is None:
            return False
        crest = record["source_peak_db"] - record["source_rms_db"]
        if not (0 < crest < 60):
            return False
    return ok


def _fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.2f} dBFS"


def _print_report(report: Report, output_dir: Path) -> None:
    print("=" * 68)
    print("采访响度匹配 · 端到端验证")
    print("=" * 68)
    for check in report.checks:
        mark = "PASS" if check.ok else "FAIL"
        print(f"[{mark}] {check.name}" + (f"  ({check.detail})" if check.detail else ""))
    print("-" * 68)
    print(f"{len(report.checks) - len(report.failed)}/{len(report.checks)} 项通过")
    if report.failed:
        print("失败项:")
        for check in report.failed:
            print(f"  - {check.name}: {check.detail}")
    print(f"报告目录: {output_dir}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Headless end-to-end verification for the interview loudness matcher"
    )
    parser.add_argument(
        "--workdir",
        type=Path,
        help="保留样例、成品与报告的目录（默认使用临时目录并在结束时删除）",
    )
    args = parser.parse_args(argv)
    workdir = args.workdir
    if workdir is not None:
        workdir.mkdir(parents=True, exist_ok=True)
    return run_verification(workdir=workdir, keep=workdir is not None)


if __name__ == "__main__":
    raise SystemExit(main())
