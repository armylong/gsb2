#!/usr/bin/env python3
"""端到端自检: 生成样例 → 分析 → 编辑锁定 → 重分析 → 导出 → 校验。

运行 (无界面, 不需要声卡):
    python verify.py
"""

from __future__ import annotations

import csv
import json
import sys
import tempfile
import wave
from pathlib import Path

from oral_segmenter.audio import AudioData
from oral_segmenter.demo import make_demo_wav
from oral_segmenter.editing import move_segment, resize_segment
from oral_segmenter.export import ExportError, export_segments
from oral_segmenter.segmentation import AnalysisParams, Segment, analyze


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check_raises(callable_, error: type[BaseException], message: str) -> None:
    try:
        callable_()
    except error:
        return
    raise AssertionError(message)


def assert_invariants(segments, total: int) -> None:
    previous_end = 0
    for seg in segments:
        check(0 <= seg.start < seg.end <= total, f"段越界: {seg}")
        check(seg.start >= previous_end, f"段重叠: {seg}")
        previous_end = seg.end


def read_wav_frames(path: Path) -> tuple[int, int, int, bytes]:
    with wave.open(str(path), "rb") as handle:
        return (
            handle.getnchannels(),
            handle.getsampwidth(),
            handle.getframerate(),
            handle.readframes(handle.getnframes()),
        )


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        wav_path = make_demo_wav(root / "oral_demo.wav")
        audio = AudioData.from_wav(wav_path)
        total = audio.frame_count
        print(f"样例: {wav_path.name}, {audio.sample_rate} Hz, "
              f"{audio.channels} ch, {audio.bit_depth} bit, {total} 帧, "
              f"{audio.duration_seconds:.2f}s")

        params = AnalysisParams()
        segments = analyze(audio, params)
        assert_invariants(segments, total)
        check(len(segments) == 3, f"默认参数应得到 3 段, 实际 {len(segments)}")
        # 组内短停顿不应切段: 第 1 段覆盖 0.00–1.13s 的两个爆发
        check(segments[0].start == 0, "首段应从 0 开始 (余量贴边)")
        check(segments[0].end >= int(1.1 * audio.sample_rate),
              "首段应包含 90ms 短停顿后的第二个爆发")
        check(segments[-1].end == total, "末段应延伸到文件末尾 (余量贴边)")
        print("分析: " + ", ".join(
            f"#{i + 1}[{s.start},{s.end})" for i, s in enumerate(segments)
        ))

        # 集中在同一段里的短停顿 (90ms) 在 150ms 门限下仍不切; 门限降到 80ms 才切
        strict = analyze(audio, AnalysisParams(min_pause_ms=150))
        check(len(strict) == 3, f"150ms 停顿门限应仍为 3 段, 实际 {len(strict)}")
        loose = analyze(audio, AnalysisParams(min_pause_ms=80))
        check(len(loose) > 3, "80ms 停顿门限应把短停顿切开")
        merges = analyze(
            audio, AnalysisParams(lead_ms=600, tail_ms=600,
                                  conflict_policy="merge")
        )
        assert_invariants(merges, total)
        check(len(merges) < len(segments), "merge 策略应减少段数")
        check(any(s.origin == "merged" for s in merges),
              "merge 后的段应带 merged 来源标记")
        truncs = analyze(
            audio, AnalysisParams(lead_ms=600, tail_ms=600,
                                  conflict_policy="truncate")
        )
        assert_invariants(truncs, total)
        check(len(truncs) == len(segments), "truncate 策略不应丢段")
        print(f"门限/冲突: 150ms->{len(strict)} 段, 80ms->{len(loose)} 段, "
              f"merge->{len(merges)} 段, truncate->{len(truncs)} 段")

        # 人工把第 2 段左移并缩短, 标记为锁定
        index = 1
        target_start = segments[index].start - 800
        edited = move_segment(segments, index, target_start, total)
        edited = resize_segment(
            edited, index, edited[index].start, edited[index].end - 400, total
        )
        assert_invariants(edited, total)
        check(edited[index].pinned, "人工编辑后应自动锁定")
        pinned_span = (edited[index].start, edited[index].end)
        print(f"人工编辑: 第 2 段 -> {pinned_span}, pinned=True")

        # 换一组参数重分析, 锁定段必须原样保留且不与自动段重叠
        new_params = AnalysisParams(
            window_ms=30, hop_ms=15, open_db=-32, close_db=-38,
            min_pause_ms=250, lead_ms=60, tail_ms=60, conflict_policy="truncate",
        )
        reanalyzed = analyze(
            audio, new_params, pins=[s for s in edited if s.pinned]
        )
        assert_invariants(reanalyzed, total)
        survivor = next(
            (s for s in reanalyzed if (s.start, s.end) == pinned_span), None
        )
        check(survivor is not None, f"锁定段 {pinned_span} 未被保留")
        check(survivor.pinned, "保留段应保持 pinned")
        print("重分析: 锁定段保持原样, 自动段绕开, 共 "
              f"{len(reanalyzed)} 段")

        # 关闭保留后, 锁定段应被重算结果替代
        without_pins = analyze(
            audio, AnalysisParams(keep_pinned=False), pins=[s for s in edited if s.pinned]
        )
        assert_invariants(without_pins, total)
        check(
            all((s.start, s.end) != pinned_span for s in without_pins),
            "keep_pinned=False 时不应保留锁定段",
        )
        print("对照: keep_pinned=False 时忽略锁定段")

        # 越界/重叠/空结果都必须被拒绝
        check_raises(
            lambda: export_segments(audio, [], root / "empty"),
            ExportError,
            "空段列表应拒绝导出",
        )
        check_raises(
            lambda: export_segments(
                audio, [Segment(0, 100), Segment(50, 200)], root / "overlap"
            ),
            ExportError,
            "重叠段应拒绝导出",
        )
        check_raises(
            lambda: export_segments(
                audio, [Segment(0, total + 1)], root / "oob"
            ),
            ExportError,
            "越界段应拒绝导出",
        )
        check(not (root / "overlap").exists(), "被拒绝的导出不应留下目录")
        print("校验: 空/重叠/越界导出均被拒绝")

        # 导出并逐段核对
        result = export_segments(audio, reanalyzed, root / "out", params=new_params)
        with result.csv_path.open(encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        check(len(rows) == len(reanalyzed), "CSV 行数与段数不一致")
        manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
        check(len(manifest["segments"]) == len(reanalyzed), "manifest 段数不一致")
        check(result.total_samples == sum(s.length for s in reanalyzed),
              "导出总样本数不一致")

        for row, seg, wav_file in zip(rows, reanalyzed, result.wav_paths):
            start = int(row["start_sample"])
            end = int(row["end_sample"])
            check((start, end) == (seg.start, seg.end), f"CSV 边界不一致: {row}")
            check(int(row["duration_samples"]) == end - start, "CSV 时长不一致")
            channels, width, rate, payload = read_wav_frames(wav_file)
            frames = len(payload) // (channels * width)
            check(frames == end - start, f"{wav_file.name} 帧数 {frames} != {end - start}")
            check(payload == audio.slice_bytes(start, end),
                  f"{wav_file.name} PCM 内容与原始切片不一致")
            check((channels, width, rate) ==
                  (audio.channels, audio.sample_width, audio.sample_rate),
                  f"{wav_file.name} 参数不一致")

        print(f"导出: {result.directory}")
        print(f"  manifest: {result.manifest_path.name}")
        print(f"  csv: {result.csv_path.name} ({len(rows)} 行)")
        print(f"  wav: {len(result.wav_paths)} 个, 样本级校验通过")
        print("VERIFY OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"VERIFY FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
