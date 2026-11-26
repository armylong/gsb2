#!/usr/bin/env python3
"""命令行验收四种情况：正确起点 / 相似音干扰 / 背景声 / 没有匹配。

python3 scripts/verify_cases.py --samples samples
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cuefinder.audio import AudioLoadError, load_audio  # noqa: E402
from cuefinder.reference import ReferenceIndex  # noqa: E402
from cuefinder.search import (STATUS_AMBIGUOUS, STATUS_MATCH, STATUS_NO_MATCH,  # noqa: E402
                              STATUS_WEAK, align, search)

EXPECT = {
    "correct_start": dict(status={STATUS_MATCH}, label="cue_b_trill", start=0.90, tol=0.03),
    "similar_prefix": dict(status={STATUS_AMBIGUOUS}, label=None, start=0.12, tol=0.03),
    "middle_gap": dict(status={STATUS_MATCH}, label="cue_d_rise", start=0.55, tol=0.03),
    "background_noise": dict(status={STATUS_MATCH}, label="cue_c_bell", start=0.55, tol=0.05),
    "no_match": dict(status={STATUS_NO_MATCH}, label=None, start=None, tol=0.0),
    "end_overrun": dict(status={STATUS_WEAK}, label="cue_c_bell", start=None, tol=0.0),
}


def run(samples: Path, threshold: float = 0.55) -> int:
    ref_dir = samples / "references"
    q_dir = samples / "queries"
    if not ref_dir.is_dir() or not q_dir.is_dir():
        print(f"未找到样例目录: {ref_dir} / {q_dir}", file=sys.stderr)
        print("先运行: python3 scripts/make_samples.py --out samples", file=sys.stderr)
        return 2

    idx = ReferenceIndex()
    print("载入参考：")
    for p in sorted(ref_dir.glob("*.wav")):
        ref = idx.add(p)
        state = ref.status_text()
        print(f"  {ref.label:16s} {state:8s} {ref.detail_text()}")
    broken = samples / "broken_ref.wav"
    if broken.exists():
        ref = idx.add(broken)
        print(f"  {ref.label:16s} {ref.status_text():8s}（其余参考不受影响）")
    print(f"索引版本 {idx.generation} · 指纹 {idx.signature()} · 就绪 {len(idx.ready())} 条\n")

    failures = 0
    for name, spec in EXPECT.items():
        qp = q_dir / f"{name}.wav"
        if not qp.exists():
            print(f"[跳过] {name}: 缺少 {qp}")
            continue
        try:
            audio = load_audio(qp)
        except AudioLoadError as exc:
            print(f"[失败] {name}: 查询载入失败 {exc}")
            failures += 1
            continue
        out = search(idx, audio.samples, threshold=threshold, query_path=str(qp))
        ok = out.status in spec["status"]
        detail = []
        if spec["label"] and out.best is not None:
            ok = ok and out.best.label == spec["label"]
            detail.append(f"最佳 {out.best.label}")
        if spec["start"] is not None and out.best is not None:
            ok = ok and abs(out.best.start_sec - spec["start"]) <= spec["tol"]
            detail.append(f"起点 {out.best.start_sec:.3f}s（期望 {spec['start']:.2f}±{spec['tol']:.2f}）")
        if out.best is not None and name == "end_overrun":
            ok = ok and out.best.overrun > 0.05
            detail.append(f"越界 {out.best.overrun*1000:.0f}ms")
        mark = "通过" if ok else "失败"
        if not ok:
            failures += 1
        print(f"[{mark}] {name}: {out.status_label} | {out.message}")
        if detail:
            print("        " + " · ".join(detail))
        if out.query is not None and out.best is not None:
            al = align(out, out.best)
            print(f"        支持帧 {al.support_ratio*100:.0f}% · 缺少支持段 {al.unsupported}")
        print()

    # 一致性：移除最佳参考后结果必须跟着变
    print("一致性检查（移除一条参考后重新检索）：")
    out = search(idx, load_audio(q_dir / "correct_start.wav").samples, threshold)
    best_path = out.best.path if out.best else None
    before_gen, before_sig = idx.generation, idx.signature()
    if best_path:
        idx.remove(best_path)
    out2 = search(idx, load_audio(q_dir / "correct_start.wav").samples, threshold)
    consistent = (out2.generation == idx.generation and
                  out2.index_signature == idx.signature() and
                  all(c.path != best_path for c in out2.candidates))
    print(f"  移除前 版本 {before_gen} 指纹 {before_sig}")
    print(f"  移除后 版本 {out2.generation} 指纹 {out2.index_signature}")
    print(f"  结果仍引用旧参考? {'是（失败）' if not consistent else '否（通过）'}")
    if not consistent:
        failures += 1
    return 1 if failures else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--samples", default="samples")
    ap.add_argument("--threshold", type=float, default=0.55)
    args = ap.parse_args(argv)
    return run(Path(args.samples), args.threshold)


if __name__ == "__main__":
    raise SystemExit(main())
