"""ffmpeg/ffprobe 转码与测量逻辑。

原则:所有统计(文件大小、窗口码率、关键帧、画面)都来自真实输出文件,
不使用编码参数冒充测量值。视频数据按包的 pts(显示时间)归属时间窗,
因此 B 帧重排不会影响窗口归属与画面定位。
"""
import json
import os
import shutil
import subprocess


class FFError(RuntimeError):
    pass


def _need(tool):
    if not shutil.which(tool):
        raise FFError("未找到 %s,请先安装 ffmpeg(macOS: brew install ffmpeg)" % tool)


def _run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise FFError("命令执行失败:\n%s\n%s" % (" ".join(str(c) for c in cmd), (p.stderr or "")[-2000:]))
    return p.stdout


def ffprobe_json(path, entries, selector=None):
    _need("ffprobe")
    cmd = ["ffprobe", "-v", "error"]
    if selector:
        cmd += ["-select_streams", selector]
    cmd += ["-show_entries", entries, "-of", "json", path]
    return json.loads(_run(cmd))


def probe_input(path):
    """读取容器/流基本信息。"""
    d = ffprobe_json(path, "format=format_name,duration,size:stream=codec_type,codec_name,width,height,r_frame_rate")
    info = {"duration": float(d["format"]["duration"]),
            "size": int(d["format"]["size"]),
            "format": d["format"].get("format_name", "")}
    for s in d.get("streams", []):
        if s.get("codec_type") == "video" and "fps" not in info:
            num, den = s.get("r_frame_rate", "30/1").split("/")
            info.update(width=s.get("width"), height=s.get("height"),
                        fps=(float(num) / float(den)) if float(den) else 0.0,
                        vcodec=s.get("codec_name"))
        elif s.get("codec_type") == "audio" and "acodec" not in info:
            info["acodec"] = s.get("codec_name")
    info["has_video"] = "fps" in info
    info["has_audio"] = "acodec" in info
    return info


def validate_input(info):
    """输入约束:<=20s、<=720p、带音频、mp4 容器。"""
    problems = []
    if not info.get("has_video"):
        problems.append("没有视频流")
    if not info.get("has_audio"):
        problems.append("没有音频流(要求输入带音频)")
    if info.get("duration", 0) > 20.05:
        problems.append("时长 %.2f s,超过 20 s 限制" % info["duration"])
    if info.get("height") and info["height"] > 720:
        problems.append("高度 %d px,超过 720p 限制" % info["height"])
    if info.get("width") and info["width"] > 1280:
        problems.append("宽度 %d px,超过 1280 限制" % info["width"])
    fmt = info.get("format", "")
    if "mp4" not in fmt and "mov" not in fmt:
        problems.append("容器不是 mp4/mov: %s" % fmt)
    return problems


def packets(path, selector):
    return ffprobe_json(path, "packet=pts_time,size,flags", selector).get("packets", [])


def frame_pts(path):
    """全部视频帧的显示时间(升序)。"""
    pts = [float(p["pts_time"]) for p in packets(path, "v:0") if "pts_time" in p]
    return sorted(set(pts))


def analyze(path, window):
    """测量真实输出文件。

    - 视频/音频数据量 = 各自流的包 size 之和(ffprobe 实测)
    - 封装开销 = 文件大小 - 视频包总量 - 音频包总量
    - 时间窗按包的 pts(显示时间)归属,末尾不足一窗也统计
    - 关键帧取包 flags 中的 K 标记(编码器实际输出,含场景切换帧)
    """
    window = float(window)
    size = os.path.getsize(path)
    dur = float(ffprobe_json(path, "format=duration")["format"]["duration"])
    fps = probe_input(path)["fps"]
    vp = packets(path, "v:0")
    ap = packets(path, "a:0")
    vbytes = sum(int(p["size"]) for p in vp)
    abytes = sum(int(p["size"]) for p in ap)
    vpts = [float(p["pts_time"]) for p in vp if "pts_time" in p]
    apts = [float(p["pts_time"]) for p in ap if "pts_time" in p]
    max_pts = max(vpts + apts) if (vpts or apts) else 0.0
    nw = max(1, int(max_pts // window) + 1)  # 末尾不足一窗也占一窗
    vwins = [0] * nw
    awins = [0] * nw
    for p in vp:
        if "pts_time" not in p:
            continue
        i = min(nw - 1, max(0, int(float(p["pts_time"]) // window)))
        vwins[i] += int(p["size"])
    for p in ap:
        if "pts_time" not in p:
            continue
        i = min(nw - 1, max(0, int(float(p["pts_time"]) // window)))
        awins[i] += int(p["size"])
    vkbps = []
    for i, b in enumerate(vwins):
        span = min(window, max(dur - i * window, 1e-6))  # 末窗按实际时长折算
        vkbps.append(b * 8 / 1000.0 / span)
    keys = sorted(float(p["pts_time"]) for p in vp
                  if "pts_time" in p and p.get("flags", "").startswith("K"))
    return {
        "path": path, "size": size, "duration": dur, "fps": fps,
        "video_bytes": vbytes, "audio_bytes": abytes,
        "overhead_bytes": size - vbytes - abytes,
        "avg_video_kbps": vbytes * 8 / 1000.0 / dur if dur else 0,
        "avg_audio_kbps": abytes * 8 / 1000.0 / dur if dur else 0,
        "window": window,
        "video_window_bytes": vwins, "audio_window_bytes": awins,
        "video_window_kbps": vkbps,
        "keyframes": keys,
        "keyframe_intervals": [round(keys[i + 1] - keys[i], 3) for i in range(len(keys) - 1)],
        "frames_pts": sorted(set(vpts)),
    }


def transcode(inp, outp, cfg, audio_kbps):
    """按配置真实转码出可播放 mp4。分辨率/帧率跟随输入,两套仅视频参数不同。"""
    _need("ffmpeg")
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", inp,
           "-map", "0:v:0", "-map", "0:a:0",
           "-c:v", "libx264",
           "-b:v", "%dk" % int(cfg["vkbps"]),
           "-g", str(int(cfg["gop"])),
           "-preset", cfg.get("preset", "medium"),
           "-pix_fmt", "yuv420p"]
    if cfg.get("maxrate"):
        mr = int(cfg["maxrate"])
        cmd += ["-maxrate", "%dk" % mr, "-bufsize", "%dk" % int(cfg.get("bufsize") or mr * 2)]
    cmd += ["-c:a", "aac", "-b:a", "%dk" % int(audio_kbps),
            "-movflags", "+faststart", outp]
    _run(cmd)


FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]

W, H, FPS = 1280, 720, 30
SCENES = [("color=c=0x224488:s=%dx%d:r=%d:d=4" % (W, H, FPS)),   # 0-4s 静态
          ("testsrc2=s=%dx%d:r=%d:d=5" % (W, H, FPS)),          # 4-9s 纹理运动
          ("color=c=white:s=%dx%d:r=%d:d=3" % (W, H, FPS))]     # 9s 硬切白场(触发场景切换关键帧)
DURATION = 12.0


def find_font():
    for f in FONT_CANDIDATES:
        if os.path.exists(f):
            return f
    return None


def _has_drawtext():
    p = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                       capture_output=True, text=True)
    return " drawtext " in p.stdout


def _timecode(n):
    ms = int(round(n * 1000.0 / FPS))
    return "%02d:%02d:%02d.%03d" % (ms // 3600000, (ms // 60000) % 60,
                                    (ms // 1000) % 60, ms % 1000)


def _gen_overlay_frames(odir):
    """无 drawtext 的 ffmpeg 构建:用 Pillow 预渲染烧录层(时间码+帧号)。"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        raise FFError("当前 ffmpeg 无 drawtext 滤镜,需要 Pillow 生成烧录层:pip install pillow")
    font = ImageFont.truetype(find_font(), 44)
    total = int(DURATION * FPS)
    for n in range(total):
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.text((40, 40), "t=" + _timecode(n), font=font,
               fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
        d.text((40, 110), "frame %d" % n, font=font,
               fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
        img.save(os.path.join(odir, "%04d.png" % n))


def gen_sample(out):
    """生成 12s 720p30 测试片:0-4s 静态画面,4-9s 纹理运动,9s 硬切到白场,
    全程烧录时间与帧号,配 440Hz 测试音。优先用 drawtext,无则用 Pillow 烧录层。"""
    _need("ffmpeg")
    font = find_font()
    if not font:
        raise FFError("找不到可用字体,无法烧录时间码")
    inputs = []
    for s in SCENES:
        inputs += ["-f", "lavfi", "-i", s]
    inputs += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=%g" % DURATION]
    odir = None
    if _has_drawtext():
        font_esc = font.replace(":", "\\:").replace("'", "\\'")
        draw = ("drawtext=fontfile='%s':fontsize=44:fontcolor=white:borderw=2:bordercolor=black"
                % font_esc)
        fc = ("[0:v][1:v][2:v]concat=n=3:v=1:a=0,"
              + draw + ":text='t=%{pts\\:hms}':x=40:y=40,"
              + draw + ":text='frame %{n}':x=40:y=110[v]")
    else:
        odir = out + ".overlay_tmp"
        os.makedirs(odir, exist_ok=True)
        _gen_overlay_frames(odir)
        inputs += ["-framerate", str(FPS), "-i", os.path.join(odir, "%04d.png")]
        fc = ("[0:v][1:v][2:v]concat=n=3:v=1:a=0[base];"
              "[base][4:v]overlay=0:0:shortest=1[v]")
    cmd = (["ffmpeg", "-y", "-v", "error"] + inputs +
           ["-filter_complex", fc,
            "-map", "[v]", "-map", "3:a",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-g", "120",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            out])
    try:
        _run(cmd)
    finally:
        if odir:
            shutil.rmtree(odir, ignore_errors=True)
    return out


def extract_frame_jpeg(path, t):
    """取 pts >= t 的第一帧(按显示时间定位,不受 B 帧重排影响)。

    返回 (jpeg 字节, 实际帧 pts)。实际帧与请求时间相差不超过一个输出帧。
    """
    pts = frame_pts(path)
    if not pts:
        raise FFError("文件没有视频帧: " + path)
    cand = [p for p in pts if p >= t - 1e-4]
    target = cand[0] if cand else pts[-1]
    ss = max(0.0, target - 1e-4)
    cmd = ["ffmpeg", "-v", "error", "-ss", "%.4f" % ss, "-i", path,
           "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0 or not p.stdout:
        raise FFError("取帧失败: " + (p.stderr or b"").decode("utf-8", "ignore")[-500:])
    return p.stdout, target
