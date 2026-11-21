"""切分清单与片段的样本级导出。"""

from __future__ import annotations

import csv
import json
import os
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

from .audio import AudioData
from .segmentation import AnalysisParams, Segment

CSV_NAME = "segments.csv"
MANIFEST_NAME = "manifest.json"


class ExportError(Exception):
    """导出失败或结果不自洽。"""


@dataclass(frozen=True)
class ExportResult:
    directory: Path
    csv_path: Path
    manifest_path: Path
    wav_paths: tuple[Path, ...]
    total_samples: int


def default_export_dir(audio: AudioData) -> Path:
    base = audio.path.parent if audio.path else Path.cwd()
    return base / f"{audio.source_name}_segments"


def _unique_dir(target: Path) -> Path:
    """目标已存在且非空时追加 -2, -3 …, 避免覆盖旧清单。"""
    if not target.exists():
        return target
    if target.is_dir() and not any(target.iterdir()):
        return target
    counter = 2
    while True:
        candidate = target.with_name(f"{target.name}-{counter}")
        if not candidate.exists():
            return candidate
        counter += 1


def validate_segments(segments: Sequence[Segment], total_frames: int) -> None:
    previous_end = 0
    for index, seg in enumerate(segments, start=1):
        if not isinstance(seg.start, int) or not isinstance(seg.end, int):
            raise ExportError(f"第 {index} 段边界不是整数样本")
        if not (0 <= seg.start < seg.end <= total_frames):
            raise ExportError(
                f"第 {index} 段 [{seg.start}, {seg.end}) 越界, 有效范围 "
                f"[0, {total_frames}]"
            )
        if seg.start < previous_end:
            raise ExportError(
                f"第 {index} 段起点 {seg.start} 小于前段终点 {previous_end}, 存在重叠"
            )
        previous_end = seg.end


def _write_csv(path: Path, audio: AudioData, segments: Sequence[Segment]) -> None:
    header = [
        "index",
        "file",
        "start_sample",
        "end_sample",
        "start_seconds",
        "end_seconds",
        "duration_samples",
        "duration_seconds",
        "pinned",
        "adjusted",
        "origin",
    ]
    sample_rate = audio.sample_rate
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for index, seg in enumerate(segments, start=1):
            name = segment_filename(audio, index, seg)
            writer.writerow(
                [
                    index,
                    name,
                    seg.start,
                    seg.end,
                    _seconds(seg.start, sample_rate),
                    _seconds(seg.end, sample_rate),
                    seg.length,
                    _seconds(seg.length, sample_rate),
                    int(seg.pinned),
                    int(seg.adjusted),
                    seg.origin,
                ]
            )


def segment_filename(audio: AudioData, index: int, seg: Segment) -> str:
    return f"{audio.source_name}_{index:04d}.wav"


def _seconds(sample: int, sample_rate: int) -> str:
    """样本 → 秒, 小数位随采样率增加, 保证换算回样本不会丢精度。"""
    digits = max(9, len(str(sample_rate)))
    return f"{sample / sample_rate:.{digits}f}"


def _write_manifest(
    path: Path,
    audio: AudioData,
    segments: Sequence[Segment],
    params: AnalysisParams | None,
    export_dir: Path,
    wav_paths: Sequence[Path],
) -> None:
    payload = {
        "format": "oral-segmenter/1",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": {
            "name": audio.source_name,
            "path": str(audio.path) if audio.path else None,
            "sample_rate": audio.sample_rate,
            "channels": audio.channels,
            "sample_width_bytes": audio.sample_width,
            "bit_depth": audio.bit_depth,
            "total_samples": audio.frame_count,
            "duration_seconds": audio.duration_seconds,
        },
        "analysis": params.to_dict() if params else None,
        "notes": {
            "sample_unit": "frame (含全部声道的一个采样帧)",
            "boundary_semantics": "[start_sample, end_sample) 左闭右开",
            "export_dir": str(export_dir),
            "analysis_params_note": "analysis 为最近一次自动分析使用的参数; "
            "人工编辑过的段见各段的 pinned/adjusted/origin",
        },
        "segments": [
            {
                **seg.to_dict(index, audio.sample_rate),
                "file": wav_paths[index - 1].name,
            }
            for index, seg in enumerate(segments, start=1)
        ],
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def export_segments(
    audio: AudioData,
    segments: Iterable[Segment],
    directory: str | Path | None = None,
    *,
    params: AnalysisParams | None = None,
) -> ExportResult:
    """导出 CSV + manifest.json + 每段一个 WAV。

    WAV 直接切片原始 PCM 字节, 保持采样率/声道/位深, 帧数精确等于
    ``end_sample - start_sample``。
    """
    segs = sorted(segments, key=lambda s: (s.start, s.end))
    if not segs:
        raise ExportError("没有可导出的段")
    validate_segments(segs, audio.frame_count)

    if directory:
        # 用户明确指定目录时直接写入该目录; 已存在的同名文件会被覆盖。
        target = Path(directory).expanduser()
        target.mkdir(parents=True, exist_ok=True)
    else:
        target = _unique_dir(default_export_dir(audio))
        target.mkdir(parents=True, exist_ok=False)

    wav_paths: list[Path] = []
    try:
        for index, seg in enumerate(segs, start=1):
            name = segment_filename(audio, index, seg)
            wav_path = audio.write_wav_slice(target / name, seg.start, seg.end)
            # 导出后立即回读校验, 确保样本级一致。
            channels, width, rate, frames = read_wav_meta(wav_path)
            expected = seg.length
            if (channels, width, rate, frames) != (
                audio.channels,
                audio.sample_width,
                audio.sample_rate,
                expected,
            ):
                raise ExportError(
                    f"{name} 回读参数不一致: {channels}ch/{width * 8}bit/"
                    f"{rate}Hz/{frames}帧, 期望 {audio.channels}ch/"
                    f"{audio.sample_width * 8}bit/{audio.sample_rate}Hz/{expected}帧"
                )
            wav_paths.append(wav_path)

        csv_path = target / CSV_NAME
        manifest_path = target / MANIFEST_NAME
        _write_csv(csv_path, audio, segs)
        _write_manifest(manifest_path, audio, segs, params, target, wav_paths)
    except Exception:
        # 失败时清掉本次已产生的文件, 避免留下半套清单。
        for path in [*wav_paths, target / CSV_NAME, target / MANIFEST_NAME]:
            try:
                path.unlink()
            except OSError:
                pass
        raise

    return ExportResult(
        directory=target,
        csv_path=csv_path,
        manifest_path=manifest_path,
        wav_paths=tuple(wav_paths),
        total_samples=sum(seg.length for seg in segs),
    )


def read_wav_meta(path: Path) -> tuple[int, int, int, int]:
    """读取 WAV 的 (声道, 位宽, 采样率, 帧数)。"""
    with wave.open(str(path), "rb") as handle:
        return (
            handle.getnchannels(),
            handle.getsampwidth(),
            handle.getframerate(),
            handle.getnframes(),
        )


def format_timecode(sample: int, sample_rate: int) -> str:
    if sample_rate <= 0:
        return "00:00:00.000"
    total_ms = int(round(sample * 1000 / sample_rate))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def open_in_file_manager(path: Path) -> None:
    """跨平台地在文件管理器中显示目录; 失败静默。"""
    try:
        if os.name == "nt":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif os.uname().sysname == "Darwin":
            import subprocess

            subprocess.Popen(["open", str(path)])
        else:
            import subprocess

            subprocess.Popen(["xdg-open", str(path)])
    except Exception:
        pass
