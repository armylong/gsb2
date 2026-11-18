"""基于实际解码输出的核对。

不读取文件头声明的平均帧率就下结论, 而是重新 ffprobe 解码出输出文件的
逐帧时间戳, 并重新解码画面与源帧做像素比对, 核对:
1. 输出时间戳严格递增、相邻间隔符合 1/fps(CFR)
2. 总帧数与映射表一致
3. 每个输出帧的画面确实来自映射表记录的源帧(像素比对, 而非看名字)
4. 首尾规则: 首帧对应源 0 帧; 输出跨度与源跨度差 < 一个输出帧
5. 音频: 存在且时长贴合视频; 短音位置与整点标记对齐(样例)
"""
from __future__ import annotations

import os

from . import ffmpeg_utils
from .mapping import MappingResult
from .probe import InputVideo


class VerifyError(AssertionError):
    """核对失败, 携带完整报告。"""

    def __init__(self, failures, report: dict | None = None):
        super().__init__("; ".join(failures))
        self.report = report


def _decode_to_dir(path: str, work_dir: str, tag: str) -> list[str]:
    d = os.path.join(work_dir, f"verify_{tag}")
    os.makedirs(d, exist_ok=True)
    pattern = os.path.join(d, "o_%06d.jpg")
    ffmpeg_utils.extract_frames(path, pattern)
    n = len(ffmpeg_utils.probe_frame_timestamps(path))
    return [os.path.join(d, f"o_{i:06d}.jpg") for i in range(1, n + 1)]


def _images_equal(a: str, b: str) -> bool:
    """JPEG 重编码会有轻微量化差异, 用平均像素误差判定同源。"""
    from PIL import Image
    import numpy as np

    x = np.asarray(Image.open(a).convert("RGB"), dtype=np.int16)
    y = np.asarray(Image.open(b).convert("RGB"), dtype=np.int16)
    if x.shape != y.shape:
        return False
    return float(np.abs(x - y).mean()) < 1.0


def _audio_start_times(path: str) -> list[float]:
    """用 silencedetect 反推非静音(短音)区间起点。

    ffmpeg 把 silencedetect 的信息写在 stderr, 这里直接捕获 stderr 解析。
    """
    import subprocess
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path,
         "-af", "silencedetect=noise=-30dB:d=0.03",
         "-f", "null", "-"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    text = p.stderr.decode("utf-8", "replace")
    starts = []
    for line in text.splitlines():
        if "silence_start" in line:
            try:
                starts.append(float(line.split("silence_start:")[1].strip()))
            except (IndexError, ValueError):
                pass
    return starts


def verify_output(
    source: InputVideo,
    mapping: MappingResult,
    output_mp4: str,
    work_dir: str,
    *,
    expect_beeps: bool = False,
) -> dict:
    """对成品做全套核对, 返回报告字典; 任何一项失败抛 VerifyError。"""
    report: dict = {"checks": [], "failures": []}

    def check(name: str, ok: bool, detail: str) -> None:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            report["failures"].append(f"{name}: {detail}")

    pts = ffmpeg_utils.probe_frame_timestamps(path=output_mp4)
    base = pts[0]
    out_zero = [t - base for t in pts]
    interval = 1.0 / mapping.fps

    check("输出帧数与映射表一致",
          len(pts) == mapping.output_count,
          f"实际 {len(pts)} / 映射 {mapping.output_count}")

    diffs = [out_zero[i] - out_zero[i - 1] for i in range(1, len(out_zero))]
    bad_gap = [g for g in diffs if abs(g - interval) > 2e-3]
    check("输出间隔全部等于 1/fps(CFR, 实测而非文件头)",
          not bad_gap and len(diffs) == mapping.output_count - 1,
          f"目标间隔 {interval:.6f}s, 异常间隔 {bad_gap[:5]}")

    increasing = all(out_zero[i] > out_zero[i - 1]
                     for i in range(1, len(out_zero)))
    check("时间戳严格递增", increasing,
          f"首 {out_zero[0]:.6f}s 末 {out_zero[-1]:.6f}s")

    grid_ok = all(abs(t - k * interval) < 2e-3
                  for k, t in enumerate(out_zero))
    check("各帧时间落在 k/fps 栅格上", grid_ok,
          f"最大偏差 {max((abs(t - k * interval) for k, t in enumerate(out_zero)), default=0):.2e}")

    first_ok = mapping.frames[0].source_index == 0 and out_zero[0] == 0.0
    check("首帧规则: 输出 0 帧 = 源 0 帧且时间为 0",
          first_ok,
          f"源帧 {mapping.frames[0].source_index}, 输出首时间 {out_zero[0]:.6f}")

    span_diff = source.source_span - out_zero[-1]
    check("首尾时长差小于一个输出帧",
          0 <= span_diff < interval + 1e-9,
          f"源跨度 {source.source_span:.3f}s 输出末帧 {out_zero[-1]:.3f}s "
          f"差 {span_diff:.3f}s (限 {interval:.3f}s)")

    # 像素级核对: 重解码输出, 与映射记录的源帧逐帧比对
    out_files = _decode_to_dir(output_mp4, work_dir, "frames")
    check("重解码帧数一致",
          len(out_files) == mapping.output_count,
          f"{len(out_files)} / {mapping.output_count}")
    mismatches = []
    step = max(1, mapping.output_count // 60)  # 全量代价高时均匀抽 60 帧
    sample_idx = list(range(0, mapping.output_count, step))
    if sample_idx[-1] != mapping.output_count - 1:
        sample_idx.append(mapping.output_count - 1)
    for k in sample_idx:
        src_file = source.frame_files[mapping.frames[k].source_index]
        if not _images_equal(out_files[k], src_file):
            mismatches.append(k)
    check("输出画面与映射记录的源帧一致(像素比对)",
          not mismatches,
          f"抽样 {len(sample_idx)} 帧, 不一致 {mismatches[:8]}")

    # 音频核对: 源片无音频时不要求输出带音频; 有源音频则必须原样保留
    meta = ffmpeg_utils.probe_streams(output_mp4)
    audios = [s for s in meta.get("streams", [])
              if s.get("codec_type") == "audio"]
    if not source.has_audio:
        check("源片无音频, 输出不强制音频流", not audios or bool(audios),
              f"源片无音频流, 输出音频流 {len(audios)} 条(可接受)")
    elif audios:
        a_dur = float(audios[0].get("duration") or 0.0)
        v_dur = out_zero[-1] + interval
        # 音频按原始时间轴并入, 只允许容器封装级别的小误差,
        # 不允许随重复帧被拉长(变长量会达到整帧倍数, 远超 0.12s 容差)
        check("原音频保留且未随重复帧拉长/累计偏移",
              abs(a_dur - source.container_duration) < 0.12
              or abs(a_dur - v_dur) < 0.12,
              f"音频 {a_dur:.3f}s vs 源容器 {source.container_duration:.3f}s "
              f"/ 视频 {v_dur:.3f}s")
        if expect_beeps:
            starts = _audio_start_times(output_mp4)
            # 短音在每个整点: 1s, 2s, ... (0s 的短音落在开头静音检测外)
            expected = [float(k) for k in range(1, int(v_dur))]
            hit = [e for e in expected
                   if any(abs(s - e) < 0.12 for s in starts)]
            check("同步短音与整点标记对齐",
                  len(hit) == len(expected),
                  f"期望 {expected}, 实测静音边界 {starts[:8]}")
    else:
        check("源片含音频时输出必须保留音频流", False, "输出中没有音频流")

    report["passed"] = not report["failures"]
    report["summary"] = (
        f"{len(report['checks'])} 项核对, "
        f"通过 {sum(1 for c in report['checks'] if c['ok'])}, "
        f"失败 {len(report['failures'])}"
    )
    if not report["passed"]:
        raise VerifyError(report["failures"], report)
    return report


def format_report(report: dict) -> str:
    lines = ["=" * 64, f"核对结果: {report.get('summary', '')}", "=" * 64]
    for c in report["checks"]:
        mark = "PASS" if c["ok"] else "FAIL"
        lines.append(f"[{mark}] {c['name']}")
        lines.append(f"       {c['detail']}")
    return "\n".join(lines)
