"""视频导出：用当前参数逐帧处理，并保留原视频音轨。

关键约束：
  * 导出逐帧调用与预览完全相同的 :func:`greenscreen.keying.process_frame`，
    因此导出画面与预览一致；
  * 输出尺寸、帧率、帧数与源视频一致；
  * 源有音轨则原样映射过来（不重新编码音频），无音轨则输出无声视频；
  * 导出结束必须通过回读校验（能解码、尺寸/帧数/音轨符合预期），
    校验失败会删掉半成品并抛 :class:`ExportError`，绝不留下无法播放的文件。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np

from . import ExportError, MediaError
from .keying import KeyingParams, process_frame
from .media import VideoReader, find_ffmpeg, find_ffprobe, probe_video

# 输出容器 -> (视频编码, 像素格式, ffmpeg 编码器参数)
_ENCODERS = {
    ".mp4": ("h264", "yuv420p", ["-crf", "18", "-preset", "medium"]),
    ".mov": ("h264", "yuv420p", ["-crf", "18", "-preset", "medium"]),
    ".mkv": ("h264", "yuv420p", ["-crf", "18", "-preset", "medium"]),
    ".avi": ("mjpeg", "yuv420p", ["-q:v", "3"]),
}


def export_video(
    foreground_path: str | Path,
    background_path: str | Path,
    output_path: str | Path,
    params: KeyingParams,
    progress_cb=None,
) -> dict:
    """导出合成视频。

    progress_cb(done:int, total:int) 可选，用于界面进度条。
    返回包含输出元数据与校验结果的 dict。
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise ExportError("找不到 ffmpeg，无法导出视频。请安装 ffmpeg 或 imageio-ffmpeg。")

    out = Path(output_path)
    ext = out.suffix.lower()
    if ext not in _ENCODERS:
        raise ExportError(
            f"不支持导出为 {ext or '(无扩展名)'}，请选择："
            f"{'、'.join(sorted(_ENCODERS))}"
        )
    out.parent.mkdir(parents=True, exist_ok=True)

    # 静默视频先写到临时文件，音频合流成功并校验通过后再替换目标文件
    silent_tmp = out.with_name(out.stem + ".silent" + ext)
    for p in (out, silent_tmp):
        if p.exists():
            p.unlink()

    codec, pix_fmt, quality_args = _ENCODERS[ext]

    try:
        reader = VideoReader(foreground_path)
        info = reader.info
        if codec == "h264" and (info.width % 2 or info.height % 2):
            reader.close()
            _cleanup(silent_tmp, out)
            raise ExportError(
                f"源视频尺寸 {info.width}x{info.height} 含奇数边，H.264/MP4 "
                "要求宽高均为偶数。请先把素材裁剪或缩放到偶数尺寸后再导出。"
            )
        background = _load_background(background_path)
        total = info.frame_count

        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{info.width}x{info.height}",
            "-r", f"{info.fps}",
            "-i", "-",
            "-c:v", codec, "-pix_fmt", pix_fmt, *quality_args,
            str(silent_tmp),
        ]
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            for i in range(total):
                frame = reader.read_frame(i)
                if frame is None:
                    raise ExportError(f"第 {i + 1} 帧缺失，导出中止。")
                result = process_frame(frame, background, params)
                proc.stdin.write(np.ascontiguousarray(result["composite"]).tobytes())
                if progress_cb and (i % 5 == 0 or i == total - 1):
                    progress_cb(i + 1, total)
            proc.stdin.close()
        except (BrokenPipeError, OSError) as exc:
            err = proc.stderr.read().decode("utf-8", "ignore") if proc.stderr else ""
            proc.wait()
            _cleanup(silent_tmp, out)
            raise ExportError(f"ffmpeg 写入失败：{exc} {err}".strip()) from exc

        ret = proc.wait()
        if ret != 0:
            err = proc.stderr.read().decode("utf-8", "ignore") if proc.stderr else ""
            _cleanup(silent_tmp, out)
            raise ExportError(f"ffmpeg 编码失败（退出码 {ret}）：{err.strip()}")
    finally:
        reader.close()

    _mux_audio(ffmpeg, foreground_path, silent_tmp, out, info.has_audio, ext)

    # 回读校验：任何一项不过就删掉输出并报错
    verification = verify_export(out, info)
    return {"output": str(out), **verification}


def _load_background(background_path) -> np.ndarray:
    from .media import load_image

    try:
        return load_image(background_path)
    except MediaError as exc:
        raise ExportError(str(exc)) from exc


def _mux_audio(ffmpeg, src, silent_tmp, out, has_audio, ext):
    """把源视频音轨原样并入；无音轨则直接封装无声视频。"""
    if has_audio:
        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-i", str(silent_tmp),
            "-i", str(src),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c", "copy",
            "-shortest",
            str(out),
        ]
    else:
        # 没有音轨也重新封装成最终容器，保证输出文件结构完整
        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-i", str(silent_tmp),
            "-map", "0:v:0", "-c", "copy",
            str(out),
        ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if silent_tmp.exists():
        silent_tmp.unlink()
    if proc.returncode != 0 or not out.exists():
        _cleanup(None, out)
        raise ExportError(f"音轨合流/封装失败：{proc.stderr.strip()}")


def verify_export(output: Path, expected) -> dict:
    """回读校验导出文件：可解码、尺寸/帧数/音轨与源一致。"""
    if not output.exists() or output.stat().st_size == 0:
        raise ExportError("导出文件不存在或为空。")

    # 1) ffprobe 元数据
    probed = None
    if find_ffprobe():
        try:
            probed = probe_video(output)
        except MediaError as exc:
            _cleanup(None, output)
            raise ExportError(f"导出结果无法被识别为视频：{exc}") from exc
    if probed is not None:
        if probed.width != expected.width or probed.height != expected.height:
            _cleanup(None, output)
            raise ExportError(
                f"导出尺寸 {probed.width}x{probed.height} 与源 "
                f"{expected.width}x{expected.height} 不一致。"
            )
        if abs(probed.fps - expected.fps) > max(0.5, expected.fps * 0.05):
            _cleanup(None, output)
            raise ExportError(f"导出帧率 {probed.fps} 与源 {expected.fps} 不一致。")
        if expected.has_audio and not probed.has_audio:
            _cleanup(None, output)
            raise ExportError("源视频含音轨，但导出文件里没有音轨。")
        # 允许容器层帧数差 1 帧的封装误差
        if abs(probed.frame_count - expected.frame_count) > 2:
            _cleanup(None, output)
            raise ExportError(
                f"导出帧数 {probed.frame_count} 与源 {expected.frame_count} 不一致。"
            )

    # 2) OpenCV 实际解码：必须能读出非空帧
    cap = cv2.VideoCapture(str(output))
    if not cap.isOpened():
        _cleanup(None, output)
        raise ExportError("导出文件无法播放（解码打开失败）。")
    decoded = 0
    sample = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame is not None and frame.size > 0:
            decoded += 1
            if sample is None:
                sample = frame
    cap.release()
    if decoded == 0 or sample is None:
        _cleanup(None, output)
        raise ExportError("导出文件没有任何可解码画面，已删除该文件。")
    if sample.shape[1] != expected.width or sample.shape[0] != expected.height:
        _cleanup(None, output)
        raise ExportError("导出画面实际解码尺寸与源不一致。")

    return {
        "width": expected.width,
        "height": expected.height,
        "fps": expected.fps,
        "frames_expected": expected.frame_count,
        "frames_decoded": decoded,
        "has_audio": expected.has_audio,
        "verified": True,
    }


def _cleanup(silent_tmp: Path | None, out: Path | None) -> None:
    for p in (silent_tmp, out):
        if p and p.exists():
            try:
                p.unlink()
            except OSError:
                pass
