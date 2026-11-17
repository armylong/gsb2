"""视频探测、抽帧与遮挡导出(ffmpeg 保留音频)。"""
from __future__ import annotations

import json
import os
import subprocess

import cv2

MAX_DURATION = 15.05   # 秒(允许少量容器误差)
MAX_W, MAX_H = 1280, 720


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def _frac(s: str) -> float:
    num, den = s.split("/")
    return float(num) / float(den) if float(den) else 0.0


def probe(path: str) -> dict:
    """返回视频信息;ok=False 时 errors 给出不符合要求的原因。"""
    info = {"ok": False, "errors": [], "path": path}
    if not os.path.isfile(path):
        info["errors"].append(f"文件不存在: {path}")
        return info
    if not path.lower().endswith(".mp4"):
        info["errors"].append("仅支持 mp4 文件")
    r = _run(["ffprobe", "-v", "error", "-print_format", "json",
              "-show_streams", "-show_format", path])
    if r.returncode != 0:
        info["errors"].append("ffprobe 无法读取该文件")
        return info
    data = json.loads(r.stdout)
    vstreams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    astreams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not vstreams:
        info["errors"].append("文件中没有视频流")
        return info
    v = vstreams[0]
    fps = _frac(v.get("avg_frame_rate", "0/1"))
    r_fps = _frac(v.get("r_frame_rate", "0/1"))
    nb = v.get("nb_frames")
    duration = float(data.get("format", {}).get("duration", 0.0))
    frames = int(nb) if nb and nb.isdigit() else int(round(duration * fps))
    info.update({
        "width": int(v["width"]), "height": int(v["height"]),
        "fps": fps, "fps_str": v.get("avg_frame_rate", "30/1"),
        "frames": frames, "duration": duration,
        "has_audio": bool(astreams),
    })
    if info["width"] > MAX_W or info["height"] > MAX_H:
        info["errors"].append(f"分辨率 {info['width']}x{info['height']} 超过 720p 上限")
    if duration > MAX_DURATION:
        info["errors"].append(f"时长 {duration:.2f}s 超过 15s 上限")
    if fps <= 0:
        info["errors"].append("无法确定帧率")
    elif abs(fps - r_fps) > 1e-6:
        info["errors"].append("不是恒定帧率(CFR)视频")
    if frames <= 0:
        info["errors"].append("无法确定帧数")
    info["ok"] = not info["errors"]
    return info


def extract_frames(path: str, out_dir: str, expected: int | None = None) -> int:
    """把每一帧导出为 jpg(供网页逐帧查看),返回实际帧数。"""
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(path)
    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        cv2.imwrite(os.path.join(out_dir, f"f{n:06d}.jpg"), frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 90])
        n += 1
    cap.release()
    if expected is not None and n != expected:
        raise RuntimeError(f"抽帧数量不符: 期望 {expected}, 实际 {n}")
    return n


def has_audio(path: str) -> bool:
    r = _run(["ffprobe", "-v", "error", "-select_streams", "a",
              "-show_entries", "stream=index", "-of", "csv=p=0", path])
    return bool(r.stdout.strip())


def export_masked(src_path: str, boxes: dict, active: tuple, out_path: str,
                  fps_str: str, color=(0, 0, 0)) -> dict:
    """把 [active] 范围内 boxes 指定的矩形用不透明色块遮住,导出 mp4。

    boxes: {frame_idx: (x, y, w, h)}(与网页预览同一份数据,保证逐帧一致)。
    帧数/帧率与源一致;源有音频时保留并保持同步。
    返回 {"frames": n, "out": out_path}。
    """
    start, end = active
    cap = cv2.VideoCapture(src_path)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    tmp = out_path + ".video_only.mp4"
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", fps_str, "-i", "-",
           "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", tmp]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if start <= n <= end and n in boxes:
            x, y, bw, bh = boxes[n]
            x0 = max(0, int(round(x)))
            y0 = max(0, int(round(y)))
            x1 = min(w, int(round(x + bw)))
            y1 = min(h, int(round(y + bh)))
            if x1 > x0 and y1 > y0:
                cv2.rectangle(frame, (x0, y0), (x1, y1), color, thickness=-1)
        proc.stdin.write(frame.tobytes())
        n += 1
    cap.release()
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg 编码失败")
    if has_audio(src_path):
        r = _run(["ffmpeg", "-y", "-i", tmp, "-i", src_path,
                  "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                  "-c:a", "aac", "-movflags", "+faststart", out_path])
        if r.returncode != 0:
            raise RuntimeError("ffmpeg 合并音频失败: " + r.stderr[-500:])
        os.remove(tmp)
    else:
        os.replace(tmp, out_path)
    return {"frames": n, "out": out_path}
