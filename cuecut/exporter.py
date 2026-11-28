"""Export segments to WAV and verify them by reading the files back.

The exporter copies the source bytes in chunks, coarsened with ``dtype``
float64, and never resamples or dithers.  Writing the original WAV subtype
back means the written file's float64 form is bit-identical to the source's.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import numpy as np
import soundfile as sf

from .model import AudioInfo, Segment
from .plan import Plan


@dataclass
class FileResult:
    segment: Segment
    path: str
    ok: bool
    message: str = ""
    read_back_first: int = 0
    read_back_last: int = -1
    head_text: str = ""
    tail_text: str = ""


@dataclass
class ExportResult:
    files: List[FileResult] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors and all(f.ok for f in self.files)


def _subtype_for(info: AudioInfo) -> str:
    if "PCM" in info.subtype or "FLOAT" in info.subtype:
        return info.subtype
    return "PCM_24"


def export_plan(
    plan: Plan,
    out_dir: str,
    *,
    progress: Optional[Callable[[int, int, str], None]] = None,
    verify: bool = True,
) -> ExportResult:
    """Write every segment of ``plan`` into ``out_dir``."""
    result = ExportResult()
    if plan.info is None:
        result.errors.append("未加载音频，无法导出")
        return result
    problems = plan.ownership_problems()
    if problems:
        result.errors.extend("规划不完整：" + p for p in problems)
        return result
    os.makedirs(out_dir, exist_ok=True)
    total = len(plan.segments)
    for i, seg in enumerate(plan.segments, 1):
        if progress is not None:
            progress(i - 1, total, seg.label)
        path = os.path.join(out_dir, seg.file_name)
        fr = _export_one(plan.info, seg, path)
        if verify and fr.ok:
            fr = verify_file(fr, plan.info, seg)
        result.files.append(fr)
        if not fr.ok:
            result.errors.append(f"{seg.file_name}：{fr.message}")
    if progress is not None:
        progress(total, total, "完成")
    return result


def _export_one(info: AudioInfo, seg: Segment, path: str) -> FileResult:
    try:
        with sf.SoundFile(info.path, "r") as fin, sf.SoundFile(
            path,
            "w",
            samplerate=info.samplerate,
            channels=info.channels,
            subtype=_subtype_for(info),
            format="WAV",
        ) as fout:
            first = seg.first_sample
            remaining = seg.sample_count
            chunk = 1 << 18
            while remaining > 0:
                n = min(chunk, remaining)
                fin.seek(first)
                data = fin.read(n, dtype="float64", always_2d=True)
                if len(data) == 0:
                    raise IOError(
                        f"在采样 {first} 处提前读到文件尾，缺少 {remaining} 个采样"
                    )
                fout.write(data)
                first += len(data)
                remaining -= len(data)
        return FileResult(segment=seg, path=path, ok=True)
    except Exception as exc:
        return FileResult(segment=seg, path=path, ok=False, message=str(exc))


def verify_file(fr: FileResult, source: AudioInfo, seg: Segment) -> FileResult:
    """Re-open the written WAV and compare it sample-for-sample to the source."""
    try:
        back = sf.info(fr.path)
    except Exception as exc:
        fr.ok = False
        fr.message = f"重新打开失败：{exc}"
        return fr
    if back.samplerate != source.samplerate:
        fr.ok = False
        fr.message = f"采样率不符：写入 {back.samplerate}，应为 {source.samplerate}"
        return fr
    if back.channels != source.channels:
        fr.ok = False
        fr.message = f"声道数不符：写入 {back.channels}，应为 {source.channels}"
        return fr
    if back.subtype != _subtype_for(source):
        fr.ok = False
        fr.message = (
            f"量化格式不符：写入 {back.subtype}，源为 {source.subtype}"
        )
        return fr
    if back.frames != seg.sample_count:
        fr.ok = False
        fr.message = (
            f"采样数不符：文件有 {back.frames} 采样，区间要求 {seg.sample_count}"
            f"（{seg.first_sample}..{seg.last_sample}）"
        )
        return fr
    chunk = 1 << 18
    offset = 0
    while offset < seg.sample_count:
        n = min(chunk, seg.sample_count - offset)
        a = read_range(fr.path, offset, n)
        b = read_range(source.path, seg.first_sample + offset, n)
        if not np.array_equal(a, b):
            bad = int(np.argmax(~np.all(a == b, axis=1)))
            fr.ok = False
            fr.message = (
                f"采样不一致：文件第 {offset + bad} 个采样"
                f"（源采样 {seg.first_sample + offset + bad}）读回不同"
            )
            return fr
        offset += len(a)
    fr.ok = True
    fr.message = f"回读核对通过：{seg.sample_count} 采样与源文件 {seg.first_sample}..{seg.last_sample} 逐一相同"
    fr.read_back_first = seg.first_sample
    fr.read_back_last = seg.last_sample
    return fr


def read_range(path: str, first: int, count: int) -> np.ndarray:
    with sf.SoundFile(path, "r") as f:
        f.seek(first)
        return f.read(count, dtype="float64", always_2d=True)


def verify_head_tail(fr: FileResult, source: AudioInfo, seg: Segment) -> FileResult:
    """Re-open the written file and compare only its first/last sample.

    Deliberately independent of ``verify_file``'s full pass: the GUI's
    "re-check head/tail" action calls this against files already on disk.
    """
    try:
        back = sf.info(fr.path)
        n = back.frames
        if n != seg.sample_count:
            fr.ok = False
            fr.tail_text = f"长度不符：{n} vs {seg.sample_count}"
            return fr
        head_back = read_range(fr.path, 0, 1)
        head_src = read_range(source.path, seg.first_sample, 1)
        head_ok = np.array_equal(head_back, head_src)
        tail_back = read_range(fr.path, n - 1, 1)
        tail_src = read_range(source.path, seg.last_sample, 1)
        tail_ok = np.array_equal(tail_back, tail_src)
        fr.head_text = (
            f"{'✓' if head_ok else '✗'} 头采样 {seg.first_sample} "
            f"（文件值 {head_back[0].tolist()} / 源值 {head_src[0].tolist()}）"
        )
        fr.tail_text = (
            f"{'✓' if tail_ok else '✗'} 尾采样 {seg.last_sample} "
            f"（文件值 {tail_back[0].tolist()} / 源值 {tail_src[0].tolist()}）"
        )
        fr.ok = fr.ok and head_ok and tail_ok
        return fr
    except Exception as exc:
        fr.ok = False
        fr.head_text = f"✗ 重新打开失败：{exc}"
        return fr


def verify_exported_head_tail(out_dir: str, plan: Plan) -> List[FileResult]:
    """For files already written: check existence, length, head and tail."""
    rows: List[FileResult] = []
    for seg in plan.segments:
        path = os.path.join(out_dir, seg.file_name)
        fr = FileResult(segment=seg, path=path, ok=True)
        if not os.path.exists(path):
            fr.ok = False
            fr.head_text = "✗ 文件不存在"
            rows.append(fr)
            continue
        if plan.info is None:
            fr.ok = False
            fr.head_text = "✗ 未加载源音频"
            rows.append(fr)
            continue
        rows.append(verify_head_tail(fr, plan.info, seg))
    return rows


def verify_junction(out_dir: str, plan: Plan) -> List[str]:
    """Prove that concatenating output files reproduces the whole source.

    Reads every file in plan order, maps its samples back to its source
    range, and compares with the source.  Returns problem strings (empty
    means perfect reconstruction, no gaps, no repeats).
    """
    problems: List[str] = []
    if plan.info is None:
        return ["未加载音频"]
    source = plan.info
    all_back: List[np.ndarray] = []
    for seg in plan.segments:
        path = os.path.join(out_dir, seg.file_name)
        try:
            back = read_range(path, 0, seg.sample_count)
        except Exception as exc:
            problems.append(f"{seg.file_name} 无法读取：{exc}")
            continue
        src = read_range(source.path, seg.first_sample, seg.sample_count)
        if len(back) != seg.sample_count:
            problems.append(
                f"{seg.file_name} 读回 {len(back)} 采样，规划要求 {seg.sample_count}"
            )
            continue
        if not np.array_equal(back, src):
            bad = int(np.argmax(~np.all(back == src, axis=1)))
            problems.append(
                f"{seg.file_name} 第 {bad} 个采样与源 {seg.first_sample + bad} 不同"
            )
        all_back.append(back)
    if problems:
        return problems
    # Segments must be contiguous by construction; assert it explicitly so a
    # gap or overlap shows up as a concrete sample range, not silent silence.
    expected = 0
    for seg in plan.segments:
        if seg.first_sample != expected:
            kind = "漏读" if seg.first_sample > expected else "重读"
            problems.append(
                f"规划在采样 {min(expected, seg.first_sample)}.."
                f"{max(expected, seg.first_sample) - 1} 处{kind}"
            )
            return problems
        expected = seg.last_sample + 1
    if expected != source.total_samples:
        problems.append(
            f"规划末段结束于 {expected}，源共 {source.total_samples} 采样"
        )
        return problems

    joined = np.concatenate(all_back, axis=0)
    if len(joined) != source.total_samples:
        problems.append(f"拼接总长 {len(joined)} 与源 {source.total_samples} 不符")
        return problems
    # Compare the concatenation against the source in chunks so a long master
    # does not need a second whole-file copy in memory.
    chunk = 1 << 20
    offset = 0
    while offset < len(joined):
        n = min(chunk, len(joined) - offset)
        piece = joined[offset:offset + n]
        ref = read_range(source.path, offset, n)
        if len(ref) != n:
            problems.append(f"源文件在采样 {offset} 处读回不足 {n} 采样")
            return problems
        if not np.array_equal(piece, ref):
            bad = int(np.argmax(~np.all(piece == ref, axis=1)))
            problems.append(f"整卷拼接在采样 {offset + bad} 处与源不同")
            return problems
        offset += n
    return problems
