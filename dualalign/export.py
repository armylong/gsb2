"""导出对齐 wav 与时间对应说明 (JSON + 可读文本).

导出结果再次载入时, 用 ``load_exported`` 可以还原出与预览一致的
时间映射与锚点, 用于回归验证。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from .align import AlignmentResult, Anchor, GapRegion, TimelineCurve
from .audio import AudioClip, load_wav
from .render import RenderSummary, render_aligned


DESCRIPTION_SUFFIX = ".timeline.json"
README_SUFFIX = ".timeline.txt"


def export_result(
    result: AlignmentResult,
    output_wav: str | Path,
    description_path: str | Path | None = None,
    subtype: str = "FLOAT",
) -> tuple[RenderSummary, Path, Path]:
    """导出对齐 wav + 时间对应说明, 返回 (渲染信息, wav 路径, 说明路径)。"""

    out_wav = Path(output_wav)
    if out_wav.suffix.lower() != ".wav":
        out_wav = out_wav.with_suffix(".wav")
    desc = (
        Path(description_path)
        if description_path
        else out_wav.parent / (out_wav.stem + DESCRIPTION_SUFFIX)
    )
    summary = render_aligned(result, out_wav, subtype=subtype)
    payload = result.description_dict()
    payload["render"] = summary.as_dict()
    payload["render"]["output_sha256"] = _file_sha256(out_wav)
    desc.parent.mkdir(parents=True, exist_ok=True)
    desc.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    readme = desc.with_name(desc.name[: -len(DESCRIPTION_SUFFIX)] + README_SUFFIX)
    readme.write_text(render_readme(result, summary), encoding="utf-8")
    return summary, out_wav, desc


def _file_sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def render_readme(result: AlignmentResult, summary: RenderSummary) -> str:
    lines: list[str] = []
    lines.append("双录音对齐结果说明")
    lines.append("=" * 40)
    lines.append("")
    lines.append(f"参考录音 (时间基准): {result.ref_clip.path.name}")
    lines.append(
        f"  时长 {result.ref_duration:.3f} s | {result.ref_clip.sample_rate} Hz | "
        f"{result.ref_clip.channels} ch"
    )
    lines.append(f"待对齐录音 (经过时间调整): {result.take_clip.path.name}")
    lines.append(
        f"  原始时长 {result.take_duration:.3f} s | {result.take_clip.sample_rate} Hz | "
        f"{result.take_clip.channels} ch"
    )
    lines.append(f"  原始文件 SHA-256: {result.take_clip.file_sha256()}")
    lines.append("")
    lines.append(f"导出文件: {summary.output_path.name}")
    lines.append(
        f"  与参考等长: {summary.frames} 帧 = {summary.frames / summary.sample_rate:.3f} s "
        f"@ {summary.sample_rate} Hz, {summary.channels} ch"
    )
    lines.append(f"  SHA-256: {_file_sha256(summary.output_path)}")
    lines.append("  注意: 导出内容经过时间拉伸/压缩, 不是原始待对齐文件的拷贝")
    lines.append("")
    lines.append("有效声音区间 (参考时间轴, 单位秒):")
    if summary.valid_regions:
        for a, b in summary.valid_regions:
            lines.append(f"  {a:8.3f} - {b:8.3f}")
    else:
        lines.append("  (无)")
    lines.append("")
    lines.append("静音/缺失区间 (导出为静音, 不代表原始录音里有该内容):")
    if result.gaps:
        for g in result.gaps:
            if g.kind == "lead_in":
                seam = "待对齐录音起点 0.000 s"
            elif g.kind == "lead_out":
                seam = f"待对齐录音终点 {result.take_duration:.3f} s"
            else:
                seam = f"待对齐接缝 {g.take_time:.3f} s"
            lines.append(
                f"  {g.ref_start:8.3f} - {g.ref_end:8.3f}  {g.label}"
                f" (时长 {g.duration:.3f} s; {seam})"
            )
    else:
        lines.append("  (无)")
    lines.append("")
    lines.append("分段漂移趋势:")
    for seg in result.trend.segments:
        lines.append(
            f"  参考 {seg['ref_start_s']:.3f}-{seg['ref_end_s']:.3f} s: "
            f"伸缩系数 {seg['slope_take_per_ref']:.4f} "
            f"({seg['drift_percent']:+.2f}% 漂移)"
        )
    for note in result.trend.notes:
        lines.append(f"  * {note}")
    lines.append("")
    lines.append("人工锚点 (参考时间 -> 待对齐时间):")
    if result.anchors:
        for a in result.anchors:
            suffix = f"  # {a.note}" if a.note else ""
            lines.append(f"  {a.ref_time:8.3f} -> {a.take_time:8.3f}{suffix}")
    else:
        lines.append("  (无, 完全使用自动分析结果)")
    lines.append("")
    lines.append("置信不足区间 (建议人工核对):")
    if result.low_confidence:
        for r in result.low_confidence:
            lines.append(f"  {r.ref_start:8.3f} - {r.ref_end:8.3f}  {r.reason}")
    else:
        lines.append("  (无)")
    lines.append("")
    if result.warnings:
        lines.append("提示:")
        for w in result.warnings:
            lines.append(f"  - {w}")
        lines.append("")
    lines.append("说明: 本工具只做时间对应, 不做混音、增益或音量包络处理。")
    return "\n".join(lines) + "\n"


def load_exported(description_path: str | Path) -> dict:
    """读取导出时写下的时间对应说明 (JSON), 用于核对/再载入。"""

    p = Path(description_path)
    if not p.is_file():
        raise FileNotFoundError(f"找不到说明文件: {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def reopen_exported(
    description_path: str | Path,
    ref_path: str | Path | None = None,
    take_path: str | Path | None = None,
    search_dirs: list[str | Path] | None = None,
) -> tuple[AudioClip, AudioClip, "AlignmentResult", dict]:
    """重新打开导出结果时用: 读取说明, 载入原始录音并重建结果对象。

    说明里记录了当时使用的曲线与锚点; 重新载入后应能复现相同位置。
    查找原始录音的顺序: 显式路径 -> 说明文件同目录 -> ``search_dirs``。
    都找不到时抛 FileNotFoundError, 由界面提示用户手动指定。
    """

    from .align import AlignmentResult, LowConfidenceRegion, MatchPoint, TrendSummary

    payload = load_exported(description_path)
    base = Path(description_path)
    folders = [base.parent]
    for extra in search_dirs or []:
        p = Path(extra)
        if p not in folders:
            folders.append(p)

    def _resolve(name: str, explicit: str | Path | None) -> Path:
        if explicit is not None:
            return Path(explicit)
        for folder in folders:
            candidate = folder / name
            if candidate.is_file():
                return candidate
        raise FileNotFoundError(
            f"找不到说明中记录的录音 {name}; 请把原始录音放到说明文件同目录, 或手动指定"
        )

    ref = load_wav(_resolve(payload["reference"]["file"], ref_path), "reference")
    take = load_wav(_resolve(payload["take"]["file"], take_path), "take")
    curve = curve_from_description(payload)
    anchors = anchors_from_description(payload)
    gaps = curve.gaps
    matches = [
        MatchPoint(
            take_time=float(m["take_s"]),
            ref_time=float(m["ref_s"]),
            score=float(m.get("score", 0.0)),
            margin=float(m.get("margin", 0.0)),
            ambiguous=bool(m.get("ambiguous", False)),
            refined=bool(m.get("refined", False)),
            ncc=float(m.get("ncc", 0.0)),
        )
        for m in payload.get("matches", [])
    ]
    low = [
        LowConfidenceRegion(
            float(r["ref_start_s"]), float(r["ref_end_s"]),
            str(r.get("reason", "")), str(r.get("severity", "warning")),
        )
        for r in payload.get("low_confidence", [])
    ]
    trend_payload = payload.get("trend", {})
    trend = TrendSummary(
        segments=list(trend_payload.get("segments", [])),
        samples=list(trend_payload.get("samples", [])),
        overall_drift_percent=trend_payload.get("overall_drift_percent"),
        notes=list(trend_payload.get("notes", [])),
    )
    result = AlignmentResult(
        ref_clip=ref,
        take_clip=take,
        matches=matches,
        probes=[],
        curve=curve,
        gaps=gaps,
        low_confidence=low,
        trend=trend,
        anchors=anchors,
        auto_curve=curve,
        warnings=list(payload.get("warnings", [])),
        analysis_params=dict(payload.get("analysis_params", {})),
    )
    return ref, take, result, payload


def curve_from_description(payload: dict) -> TimelineCurve:
    curve = payload["curve"]
    gaps = [
        GapRegion(
            ref_start=float(g["ref_start_s"]),
            ref_end=float(g["ref_end_s"]),
            take_time=float(g["take_time_s"]),
            kind=str(g["kind"]),
        )
        for g in payload.get("gaps", [])
    ]
    return TimelineCurve(
        np.asarray(curve["knots_ref_s"], dtype=np.float64),
        np.asarray(curve["knots_take_s"], dtype=np.float64),
        gaps,
    )


def anchors_from_description(payload: dict) -> list[Anchor]:
    return [
        Anchor(float(a["ref_s"]), float(a["take_s"]), str(a.get("note", "")))
        for a in payload.get("anchors", [])
    ]


def verify_export(description_path: str | Path, tolerant_s: float = 0.002) -> dict:
    """检查导出 wav 与说明是否一致: 时长, 说明中的曲线是否落在同一位置上。

    返回包含 ``ok`` 与各检查项的结果字典, 供测试断言使用。
    """

    payload = load_exported(description_path)
    base = Path(description_path)
    stem = base.name[: -len(DESCRIPTION_SUFFIX)] if base.name.endswith(DESCRIPTION_SUFFIX) else base.stem
    wav_path = base.with_name(stem + ".wav")
    info = sf.info(str(wav_path))
    curve = curve_from_description(payload)
    anchors = anchors_from_description(payload)
    ref_dur = float(payload["reference"]["duration_s"])
    expected_frames = int(round(ref_dur * int(payload["reference"]["sample_rate"])))
    checks = {
        "frames": info.frames == expected_frames,
        "sample_rate": int(info.samplerate) == int(payload["reference"]["sample_rate"]),
        "channels": int(info.channels) == int(payload["reference"]["channels"]),
        "curve_monotonic": bool(np.all(np.diff(curve.knots_take) >= -1e-9)),
        "anchors_on_curve": all(
            abs(float(curve.take_time_at(a.ref_time)) - a.take_time) <= tolerant_s
            for a in anchors
        ),
    }
    return {
        "ok": all(checks.values()),
        "checks": checks,
        "wav": wav_path,
        "description": base,
        "frames": info.frames,
        "expected_frames": expected_frames,
        "anchors": anchors,
        "curve": curve,
        "payload": payload,
    }


def load_for_reopen(description_path: str | Path) -> tuple[AudioClip, AudioClip, dict]:
    """重新打开导出结果: 返回 (参考, 对齐结果, 说明) 三个对象。

    查找参考/待对齐原始文件时按说明里的文件名在原目录及说明文件同级目录,
    找不到时抛 FileNotFoundError, 由界面提示重新选择。
    """

    from .audio import load_wav

    payload = load_exported(description_path)
    base = Path(description_path)
    folder = base.parent
    ref_name = payload["reference"]["file"]
    take_name = payload["take"]["file"]
    ref_path = folder / ref_name
    take_path = folder / take_name
    if not ref_path.is_file():
        raise FileNotFoundError(f"找不到说明中记录的参考录音: {ref_name}")
    if not take_path.is_file():
        raise FileNotFoundError(f"找不到说明中记录的待对齐录音: {take_name}")
    ref = load_wav(ref_path, "reference")
    take = load_wav(take_path, "take")
    return ref, take, payload
