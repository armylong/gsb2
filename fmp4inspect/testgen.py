"""生成测试材料: 正常 / 换序 / 末尾截断, 并读回核对导出范围."""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
from typing import List, Optional, Tuple

from .analyze import load_presentation
from .exporter import common_coverage, export_range


def _run(cmd: List[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"命令失败: {' '.join(cmd)}\n"
                           + r.stderr.decode("utf-8", "replace")[:800])
    return r


def _top_level_spans(path: str) -> List[Tuple[str, int, int]]:
    """返回顶层 box 的 (类型, 起始, 结束)."""
    with open(path, "rb") as f:
        buf = f.read()
    spans, pos = [], 0
    while pos + 8 <= len(buf):
        size, typ = struct.unpack_from(">I4s", buf, pos)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            header = 16
        elif size == 0:
            size = len(buf) - pos
        spans.append((typ.decode("latin-1"), pos, pos + size))
        pos += size
    return spans


def split_fmp4(fmp4_path: str, outdir: str) -> Tuple[str, List[str]]:
    """把完整 fmp4 拆成 init.mp4 + seg_N.m4s. 返回 (init路径, [片段路径])."""
    with open(fmp4_path, "rb") as f:
        buf = f.read()
    spans = _top_level_spans(fmp4_path)
    moov_end = next(e for t, s, e in spans if t == "moov")
    init_path = os.path.join(outdir, "init.mp4")
    with open(init_path, "wb") as f:
        f.write(buf[:moov_end])
    segs: List[str] = []
    moof_idx = [i for i, (t, s, e) in enumerate(spans) if t == "moof"]
    for n, i in enumerate(moof_idx, 1):
        start = spans[i][1]
        end = spans[moof_idx[n]][1] if n < len(moof_idx) else len(buf)
        p = os.path.join(outdir, f"seg_{n:02d}.m4s")
        with open(p, "wb") as f:
            f.write(buf[start:end])
        segs.append(p)
    return init_path, segs


def generate_materials(outdir: str, source: Optional[str] = None,
                       duration: float = 6.0) -> dict:
    """生成 normal / reordered / truncated 三套材料. 返回各套的文件清单."""
    os.makedirs(outdir, exist_ok=True)
    if source is None:
        source = os.path.join(outdir, "source.mp4")
        _run(["ffmpeg", "-y", "-v", "error",
              "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
              "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
              "-t", str(duration),
              "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p",
              "-c:a", "aac", source])
    fmp4 = os.path.join(outdir, "frag_full.mp4")
    _run(["ffmpeg", "-y", "-v", "error", "-i", source, "-c", "copy",
          "-movflags", "frag_keyframe+empty_moov+default_base_moof",
          "-frag_duration", "1000000", fmp4])

    result = {"fmp4": fmp4, "source": source}

    # 1) 正常
    ndir = os.path.join(outdir, "normal")
    os.makedirs(ndir, exist_ok=True)
    init, segs = split_fmp4(fmp4, ndir)
    result["normal"] = [init] + segs

    # 2) 换序: 交换中间两个片段 (文件名保持顺序, 内容换序 —— 模拟按错误顺序选入)
    rdir = os.path.join(outdir, "reordered")
    os.makedirs(rdir, exist_ok=True)
    init2, segs2 = split_fmp4(fmp4, rdir)
    if len(segs2) >= 4:
        a, b = segs2[1], segs2[2]  # seg_02, seg_03
        ta, tb = a + ".tmp", b + ".tmp"
        os.rename(a, ta)
        os.rename(b, a)
        os.rename(ta, b)
    result["reordered"] = [init2] + segs2

    # 3) 末尾截断: 最后一个片段砍掉尾部 40%
    tdir = os.path.join(outdir, "truncated")
    os.makedirs(tdir, exist_ok=True)
    init3, segs3 = split_fmp4(fmp4, tdir)
    last = segs3[-1]
    with open(last, "rb") as f:
        data = f.read()
    with open(last, "wb") as f:
        f.write(data[: int(len(data) * 0.6)])
    result["truncated"] = [init3] + segs3

    return result


def self_check(outdir: str) -> List[str]:
    """对三套材料跑分析 + 导出核对, 返回检查日志."""
    log: List[str] = []

    def analyze_dir(name: str):
        d = os.path.join(outdir, name)
        files = sorted(os.listdir(d))
        paths = [os.path.join(d, f) for f in files
                 if f.endswith((".mp4", ".m4s"))]
        return load_presentation(paths)

    # 正常: 不应有 error
    pres = analyze_dir("normal")
    errs = [i.message for i in pres.issues if i.severity == "error"]
    log.append(f"[normal] 错误数={len(errs)} (期望 0) " + ("✓" if not errs else "✗ " + "; ".join(errs)))
    cov = common_coverage(pres)
    log.append(f"[normal] 共同覆盖区间: {[(f'{a:.2f}', f'{b:.2f}') for a, b in cov]}")

    # 换序: 应报 order, 不应报 missing(error)
    pres_r = analyze_dir("reordered")
    has_order = any(i.category == "order" for i in pres_r.issues)
    has_missing_err = any(i.category == "missing" and i.severity == "error"
                          for i in pres_r.issues)
    log.append(f"[reordered] 检出顺序错误={has_order} (期望 True), "
               f"误报缺失={has_missing_err} (期望 False) "
               + ("✓" if has_order and not has_missing_err else "✗"))

    # 截断: 应报 truncated
    pres_t = analyze_dir("truncated")
    has_trunc = any(i.category == "truncated" for i in pres_t.issues)
    log.append(f"[truncated] 检出数据不完整={has_trunc} (期望 True) "
               + ("✓" if has_trunc else "✗"))

    # 导出核对: 从 normal 导出共同覆盖区间的中间一段
    if cov:
        a, b = cov[0]
        s, e = a + (b - a) * 0.25, a + (b - a) * 0.75
        out = os.path.join(outdir, "export_check.mp4")
        rep = export_range(pres, s, e, out)
        log.append(f"[export] 请求 [{s:.3f}s, {e:.3f}s] -> ok={rep.ok}")
        for ctype, (a0, a1, n) in rep.achieved.items():
            log.append(f"[export] 读回 {ctype}: [{a0:.3f}s, {a1:.3f}s] {n} 包")
        for m in rep.messages:
            log.append(f"[export] {m}")
    return log
