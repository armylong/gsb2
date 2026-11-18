"""mp4 导出。

坐标/插值/尺寸规则与预览完全一致: x、y 表达式由
:func:`pipeditor.model.build_ffmpeg_expr` 生成, 取整公式同样是
``floor(v+0.5)``。叠加层超出自身时长后用 ``enable='lt(n,N)'`` 关闭,
末尾画面回到纯背景; 背景音频整条保留并按背景时长截断。
"""

from __future__ import annotations

import subprocess

from .media import FFmpegNotFound, VideoInfo, _ffmpeg_bin
from .model import Project, build_ffmpeg_expr


def build_export_command(
    bg: VideoInfo,
    ov: VideoInfo,
    project: Project,
    output_path: str,
) -> list[str]:
    """组装导出命令(列表形式, 不经过 shell)。"""

    expr_x = build_ffmpeg_expr(project.keyframes, "x", project.fps)
    expr_y = build_ffmpeg_expr(project.keyframes, "y", project.fps)
    # overlay 的 n 计数器与输出帧号不对应(见 model.build_ffmpeg_expr),
    # 可见窗口同样用时间戳还原帧号: 帧号 < 叠加帧数。
    fps_num = float(project.fps)
    frame_n = f"floor(t*{fps_num:g}+0.5)"

    filter_complex = (
        f"[1:v]scale={project.overlay_w}:{project.overlay_h}"
        f":flags=lanczos,setsar=1[ov];"
        f"[0:v][ov]overlay=x='{expr_x}':y='{expr_y}'"
        f":enable='lt({frame_n},{project.overlay_frame_count})'"
        f":eval=frame:format=rgb:shortest=0[v]"
    )
    # format=rgb 至关重要: overlay 默认 yuv420 色度子采样会把 x/y 坐标
    # 向下量化到偶数(实测 x=5 渲染成 4), 导致最多 1px 且系统性偏差;
    # rgb 模式坐标逐像素精确, 最终再由输出端 -pix_fmt yuv420p 统一转换。

    duration = project.frame_count / float(project.fps)
    cmd = [
        _ffmpeg_bin("ffmpeg"),
        "-y",
        "-i",
        bg.path,
        "-i",
        ov.path,
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        # 只保留背景音频; 背景没有音轨时 '?' 让该映射可选。
        "-map",
        "0:a?",
        "-r",
        f"{float(project.fps):g}",
        "-frames:v",
        str(project.frame_count),
        "-t",
        f"{duration:.6f}",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        output_path,
    ]
    return cmd


def export_mp4(
    bg: VideoInfo,
    ov: VideoInfo,
    project: Project,
    output_path: str,
) -> list[str]:
    """执行导出, 返回实际使用的命令(便于日志与核对)。"""

    if not project.keyframes:
        raise RuntimeError("至少需要一个位置关键帧才能导出")
    cmd = build_export_command(bg, ov, project, output_path)
    try:
        proc = subprocess.run(cmd, capture_output=True)
    except FileNotFoundError as exc:  # pragma: no cover - 环境问题
        raise FFmpegNotFound("找不到 ffmpeg, 请先 brew install ffmpeg") from exc
    if proc.returncode != 0:
        raise RuntimeError(
            "ffmpeg 导出失败:\n" + proc.stderr.decode("utf-8", "replace")
        )
    return cmd
