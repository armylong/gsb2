"""自动化验证：生成样例 → 截取/重编码 → 核对输出身份与时间轴。

``cutlab.verify.run()`` 返回结构化结果，两个入口共用：

* 命令行 ``python -m cutlab.verify``：打印报告并在失败时返回非零退出码；
* GUI 的“验证”页：把同样的步骤跑在后台线程里。
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from . import audio, barcode, cut, ffmpeg, media, sample, timemap


@dataclass(slots=True)
class Check:
    name: str
    ok: bool
    detail: str = ""

    def line(self) -> str:
        mark = "PASS" if self.ok else "FAIL"
        return f"[{mark}] {self.name}" + (f" — {self.detail}" if self.detail else "")


@dataclass(slots=True)
class VerifyReport:
    checks: list[Check] = field(default_factory=list)
    sample_paths: list[str] = field(default_factory=list)
    outputs: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append(Check(name, ok, detail))

    def text(self) -> str:
        lines = ["CutLab 自动验证", "=" * 40]
        lines += [c.line() for c in self.checks]
        lines.append("-" * 40)
        lines.append("结论: " + ("全部通过" if self.ok else "存在失败项"))
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail}
                       for c in self.checks],
            "samples": self.sample_paths,
            "outputs": self.outputs,
            "details": self.details,
        }


def run(workdir: str | Path | None = None, *, keep: bool = False,
        progress=None) -> VerifyReport:
    report = VerifyReport()
    owns_dir = workdir is None
    directory = Path(workdir or tempfile.mkdtemp(prefix="cutlab-verify-"))
    directory.mkdir(parents=True, exist_ok=True)

    def step(msg: str, pct: int) -> None:
        if progress:
            progress(msg, pct)

    try:
        step("生成 0 起点样例", 5)
        base = sample.ensure_sample(directory)
        report.sample_paths.append(base["path"])

        step("生成非零起点 + 音轨提前样例", 20)
        offset_info = sample.ensure_sample(directory, offset=12.5, audio_lead=0.5)
        report.sample_paths.append(offset_info["path"])

        # ---------- 1. 关键帧识别 ----------
        step("探测关键帧", 32)
        info = media.probe(base["path"])
        expected_kfs = [i * base["fps"] for i in range(int(base["duration"]))]
        got_kfs = [kf.frame_index for kf in info.keyframes]
        report.add("样例关键帧按 1s 规律出现",
                   got_kfs[:len(expected_kfs)] == expected_kfs,
                   f"实测 {got_kfs[:8]}…")
        report.add("关键帧时间使用实际 PTS（内容时间）",
                   all(abs(kf.content_time - kf.frame_index / info.fps) < 1e-3
                       for kf in info.keyframes),
                   f"fps={info.fps:.4f}")
        report.details["keyframes"] = [
            {"index": kf.index, "content": round(kf.content_time, 4),
             "absolute": round(kf.pts, 4), "frame": kf.frame_index}
            for kf in info.keyframes
        ]

        # ---------- 2. 截取偏差 ----------
        step("核对直接截取与重编码", 45)
        start, end = 2.5, 4.0
        req_copy = cut.CutRequest(source=info, start=start, end=end,
                                  container="mp4", reencode=False)
        req_reenc = cut.CutRequest(source=info, start=start, end=end,
                                   container="mp4", reencode=True)
        pred = cut.predict(req_copy)
        copy_out = cut.run_cut(req_copy, directory / "verify_copy.mp4")
        reenc_out = cut.run_cut(req_reenc, directory / "verify_reencode.mp4")
        report.outputs += [str(copy_out.path), str(reenc_out.path)]

        report.add("直接截取的首帧就是请求的帧",
                   copy_out.first_frame_index == pred.start_frame_index,
                   f"输出首帧 #{copy_out.first_frame_index} / 请求 #{pred.start_frame_index}")
        report.add("重编码的首帧就是请求的帧",
                   reenc_out.first_frame_index == pred.start_frame_index,
                   f"输出首帧 #{reenc_out.first_frame_index} / 请求 #{pred.start_frame_index}")
        report.add("重编码时长与请求一致",
                   reenc_out.video.duration is not None
                   and abs(reenc_out.video.duration - (end - start)) < 0.02,
                   f"{reenc_out.video.duration:.4f}s vs 请求 {end - start:.3f}s")
        copy_frames = copy_out.video.frames or 0
        report.add("直接截取会带入额外帧（这正是要暴露的偏差）",
                   copy_frames >= pred.expected_frames,
                   f"{copy_frames} 帧 vs 请求 {pred.expected_frames} 帧")
        report.add("直接截取保留了音频预滚（首采样早于 0）",
                   copy_out.audio is not None
                   and copy_out.audio.first_pts is not None
                   and copy_out.audio.first_pts < -0.05,
                   f"音轨首采样 {copy_out.audio.first_pts if copy_out.audio else None}s")

        mkv_req = cut.CutRequest(source=info, start=start, end=end,
                                 container="mkv", reencode=False)
        mkv_out = cut.run_cut(mkv_req, directory / "verify_copy.mkv")
        report.outputs.append(str(mkv_out.path))
        report.add("MKV 直接截取会回退到前一关键帧",
                   mkv_out.first_frame_index is not None
                   and mkv_out.first_frame_index < pred.start_frame_index,
                   f"输出首帧 #{mkv_out.first_frame_index} / 请求 #{pred.start_frame_index}")

        copy_align = audio.measure(info.path, copy_out.path,
                                   source_absolute_start=req_copy.start_abs,
                                   duration=req_copy.duration)
        reenc_align = audio.measure(info.path, reenc_out.path,
                                    source_absolute_start=req_reenc.start_abs,
                                    duration=req_reenc.duration)
        report.add("重编码的音画内容对齐",
                   reenc_align.ok and reenc_align.lag is not None
                   and abs(reenc_align.lag) <= 0.03,
                   f"lag={reenc_align.lag}s 置信度 {reenc_align.confidence:.0%}")
        report.details["copy"] = _measure_dict(copy_out)
        report.details["reencode"] = _measure_dict(reenc_out)
        report.details["copy_audio_lag"] = copy_align.lag
        report.details["reencode_audio_lag"] = reenc_align.lag

        # ---------- 3. 非零起点定位 ----------
        step("核对非零起点定位", 70)
        off_info = media.probe(offset_info["path"])
        report.add("识别出非零文件起点",
                   off_info.content_origin > 1.0,
                   f"视频首帧 PTS {off_info.content_origin:.3f}s / "
                   f"format start {off_info.format_start:.3f}s")
        tm = timemap.demonstrate(off_info, 2.0, directory / "timemap")
        naive, absolute = tm.naive, tm.absolute
        report.add("绝对定位命中期望帧",
                   bool(absolute and absolute.ok),
                   f"首帧 #{absolute.first_frame if absolute else None} / 期望 #{tm.expected_frame}")
        report.add("相对定位在非零起点输入上产生偏移",
                   bool(naive and not naive.ok),
                   f"首帧 #{naive.first_frame if naive else None} / 期望 #{tm.expected_frame}")
        report.details["timemap"] = {
            "expected_frame": tm.expected_frame,
            "naive": _trial_dict(tm.naive),
            "absolute": _trial_dict(tm.absolute),
        }

        # ---------- 4. 导出帧身份 ----------
        step("核对导出帧身份", 88)
        src_rgb, w, h = ffmpeg.extract_first_frame_rgb(info.path)
        src_bc = barcode.decode_identity(src_rgb, w, h)
        report.add("源文件首帧条码可读",
                   src_bc.frame_index == 0 and src_bc.sync_ok and src_bc.checksum_ok,
                   f"读到 #{src_bc.frame_index}")
        last_rgb = ffmpeg.extract_rgb_frame_number(info.path,
                                                   info.probed_frames - 1, w, h)
        last_bc = barcode.decode_identity(last_rgb, w, h)
        report.add("源文件末帧条码可读",
                   last_bc.frame_index == info.probed_frames - 1,
                   f"读到 #{last_bc.frame_index}（共 {info.probed_frames} 帧）")
        report.add("重编码输出首帧条码与源同一帧",
                   reenc_out.first_frame_identity is not None
                   and reenc_out.first_frame_identity.frame_index
                   == pred.start_frame_index,
                   f"输出 #{reenc_out.first_frame_index}")

        step("完成", 100)
    except Exception as exc:  # noqa: BLE001 - 验证入口需要把异常变成失败项
        report.add("验证流程异常", False, f"{exc}")
        report.details["traceback"] = traceback.format_exc()
    finally:
        if owns_dir and not keep:
            pass  # 保留临时目录，路径会写进报告，便于人工复查

    return report


def _measure_dict(m: cut.OutputMeasure) -> dict:
    def track(t: cut.TrackMeasure | None) -> dict | None:
        if not t:
            return None
        return {
            "start": t.start, "duration": t.duration,
            "frames": t.frames, "declared_frames": t.declared_frames,
            "first_pts": t.first_pts, "last_pts": t.last_pts,
            "first_key": t.first_key,
        }
    return {
        "path": str(m.path),
        "size": m.size,
        "format_start": m.format_start,
        "format_duration": m.format_duration,
        "video": track(m.video),
        "audio": track(m.audio),
        "first_frame": m.first_frame_index,
        "last_frame": m.last_frame_index,
    }


def _trial_dict(t: timemap.Trial | None) -> dict | None:
    if not t:
        return None
    return {
        "label": t.label, "first_frame": t.first_frame,
        "expected": t.expected_frame, "ok": t.ok,
        "video_first_pts": t.video_first_pts,
        "format_start": t.format_start,
        "note": t.note, "command": t.command,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="CutLab 自动验证：生成样例、截取、核对输出帧身份")
    parser.add_argument("--workdir", help="输出目录（默认临时目录）")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = parser.parse_args(argv)

    report = run(args.workdir, progress=lambda msg, pct: print(
        f"[{pct:3d}%] {msg}", file=sys.stderr))
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2)
          if args.json else report.text())
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
