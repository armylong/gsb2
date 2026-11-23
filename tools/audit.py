"""Repair-clip audit helper: print a document's segments and changed samples.

Usage:
    python tools/audit.py path/to/audio.wav [--json out.json] [--csv out.csv]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from clipmend import analysis as an  # noqa: E402
from clipmend.document import open_document  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="打印削顶片段与真实改动采样点")
    parser.add_argument("wav", type=Path)
    parser.add_argument("--pos", type=float, default=-0.10, help="正削顶门槛 dBFS")
    parser.add_argument("--neg", type=float, default=-0.10, help="负削顶门槛 dBFS")
    parser.add_argument("--min-run", type=int, default=2)
    parser.add_argument("--join-gap", type=int, default=1)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--csv", type=Path)
    args = parser.parse_args(argv)

    doc = open_document(args.wav)
    doc.set_thresholds(args.pos, args.neg, args.min_run, args.join_gap)

    print(f"{args.wav}  {doc.wav.sample_rate} Hz  {doc.wav.channels} 声道  "
          f"{doc.wav.duration:.2f} 秒  {doc.wav.frames} 样本")
    sr = doc.wav.sample_rate
    print(f"\n检出 {len(doc.segments)} 段：")
    for view in doc.segment_views():
        seg = view.segment
        print(
            f"  #{seg.uid} ch{seg.channel + 1} {'正' if seg.polarity > 0 else '负'} "
            f"{an.format_sample_time(seg.start, sr)}–{an.format_sample_time(seg.end, sr)} "
            f"[{seg.start}:{seg.end}] {seg.length} 样本 "
            f"{an.STATUS_LABELS[seg.status]} 置信={view.confidence_label}"
            + (f"  {view.hint}" if view.hint else "")
        )
    print(f"\n实际改动 {doc.total_changed_samples()} 个样本：")
    for rec in doc.records:
        print(
            f"  #{rec.segment_uid} ch{rec.channel + 1} {rec.method} "
            f"{an.CONFIDENCE_LABELS[rec.confidence]} "
            f"{an.format_runs(rec.changed_runs, sr)}"
        )
    if args.json:
        doc.write_audit(args.json)
        print(f"\nJSON -> {args.json}")
    if args.csv:
        args.csv.write_text(doc.audit_csv(), encoding="utf-8")
        print(f"CSV  -> {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
