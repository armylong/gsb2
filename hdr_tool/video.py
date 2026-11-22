"""视频读写:ffprobe 元数据、ffmpeg 逐帧解码 (yuv420p10le)、SDR 导出 (libx264)。"""
import json
import subprocess

import numpy as np

from . import color


class VideoError(RuntimeError):
    pass


def _run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, **kw)
    if p.returncode != 0:
        raise VideoError(f"命令失败: {' '.join(cmd[:3])}...\n{p.stderr.decode(errors='replace')[:800]}")
    return p


def probe(path):
    """读取分辨率/帧率/帧数/颜色标记。返回 dict, 含每项颜色标记的来源说明。"""
    p = _run(["ffprobe", "-v", "error", "-select_streams", "v:0",
              "-show_streams", "-show_format", "-of", "json", path])
    j = json.loads(p.stdout.decode())
    st = j["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    dur = float(st.get("duration") or j.get("format", {}).get("duration") or 0)
    nb = st.get("nb_frames")
    nb_frames = int(nb) if nb and nb != "N/A" else int(round(dur * fps))
    max_cll = max_fall = None
    for sd in st.get("side_data_list", []):
        if "max_content" in sd:
            max_cll = float(sd["max_content"])
        if "max_average" in sd:
            max_fall = float(sd["max_average"])
    if max_cll is None:
        # 部分封装只在帧级 SEI 携带 MaxCLL, 读首帧 side data
        p2 = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                             "-read_intervals", "%+#1", "-show_frames",
                             "-of", "json", path], capture_output=True)
        try:
            frames = json.loads(p2.stdout.decode()).get("frames", [])
            for sd in (frames[0].get("side_data_list", []) if frames else []):
                if "max_content" in sd:
                    max_cll = float(sd["max_content"])
                if "max_average" in sd:
                    max_fall = float(sd["max_average"])
        except (json.JSONDecodeError, ValueError):
            pass
    meta = {
        "path": path,
        "width": int(st["width"]),
        "height": int(st["height"]),
        "fps": fps,
        "nb_frames": nb_frames,
        "duration": dur,
        "pix_fmt": st.get("pix_fmt", "?"),
        "color_transfer": st.get("color_transfer") or "unknown",
        "color_primaries": st.get("color_primaries") or "unknown",
        "color_space": st.get("color_space") or "unknown",
        "color_range": st.get("color_range") or "tv",
        "max_cll": max_cll,
        "max_fall": max_fall,
    }
    return meta


def resolve_transfer(meta, override):
    """决定实际使用的传递曲线, 返回 (transfer, 依据说明)"""
    t = meta["color_transfer"]
    if override and override != "auto":
        return override, f"手动指定: {override} (码流标记: {t})"
    if t in ("smpte2084", "arib-std-b67"):
        return ("smpte2084" if t == "smpte2084" else "hlg"), f"码流标记: {t}"
    if t in ("bt709", "bt470bg", "smpte170m", "iec61966-2-1"):
        return "bt709", f"码流标记: {t} (按 SDR 100nit 处理)"
    return "smpte2084", f"码流未标记({t}), 缺省按 PQ 处理, 可在界面改"


def resolve_primaries(meta, override):
    p = meta["color_primaries"]
    if override and override != "auto":
        return override, f"手动指定: {override} (码流标记: {p})"
    if p == "bt2020":
        return "bt2020", "码流标记: bt2020"
    if p in ("bt709", "unknown"):
        return ("bt709", "码流标记: bt709") if p == "bt709" else \
               ("bt2020", "码流未标记, 缺省按 BT.2020 处理, 可在界面改")
    return "bt709", f"码流标记: {p} (按 BT.709 处理)"


def src_peak_nits(meta, transfer):
    """源内容峰值估计: 优先 MaxCLL, 否则按传递曲线给缺省"""
    if meta.get("max_cll"):
        return meta["max_cll"], f"MaxCLL={meta['max_cll']:.0f}nit"
    default = {"smpte2084": 10000.0, "hlg": color.HLG_PEAK_NITS, "bt709": 100.0}[transfer]
    return default, f"无 MaxCLL 标记, 按 {default:.0f}nit"


def decode_frame(path, t, w, h):
    """解码 t 秒处一帧为 yuv420p10le, 返回 (Y, Cb, Cr) uint16 全分辨率数组(色度最近邻上采样)"""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t:.6f}", "-i", path,
           "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-"]
    p = _run(cmd)
    buf = p.stdout
    ysz, csz = w * h, (w // 2) * (h // 2)
    need = (ysz + 2 * csz) * 2
    if len(buf) < need:
        raise VideoError(f"解码得到 {len(buf)} 字节, 期望 {need}; 该时间点可能无帧")
    a = np.frombuffer(buf[:need], dtype="<u2")
    y = a[:ysz].reshape(h, w)
    cb = a[ysz:ysz + csz].reshape(h // 2, w // 2)
    cr = a[ysz + csz:].reshape(h // 2, w // 2)
    cb = np.repeat(np.repeat(cb, 2, axis=0), 2, axis=1)
    cr = np.repeat(np.repeat(cr, 2, axis=0), 2, axis=1)
    return y, cb, cr


def ycbcr_to_rgb_nits(y, cb, cr, meta, transfer, primaries):
    """10bit YCbCr -> 线性光 RGB nits"""
    limited = meta["color_range"] != "pc"
    if limited:
        yy = (y.astype(np.float64) - 64.0) / 876.0
        cb = (cb.astype(np.float64) - 512.0) / 896.0
        cr = (cr.astype(np.float64) - 512.0) / 896.0
    else:
        yy = y.astype(np.float64) / 1023.0
        cb = (cb.astype(np.float64) - 512.0) / 1023.0
        cr = (cr.astype(np.float64) - 512.0) / 1023.0
    kr, kb = color.YCBCR["bt2020" if primaries == "bt2020" else "bt709"]
    kg = 1.0 - kr - kb
    r = yy + (2 - 2 * kr) * cr
    b = yy + (2 - 2 * kb) * cb
    g = (yy - kr * r - kb * b) / kg
    rgb = np.stack([r, g, b], axis=-1)
    return color.signal_to_nits(np.clip(rgb, 0.0, 1.0), transfer)


def decode_frame_nits(path, t, meta, transfer, primaries):
    y, cb, cr = decode_frame(path, t, meta["width"], meta["height"])
    return ycbcr_to_rgb_nits(y, cb, cr, meta, transfer, primaries)


def export_sdr(src, dst, meta, transfer, primaries, settings, t0, t1, progress=None):
    """用与预览完全相同的管线导出 SDR mp4 (无音频)。

    settings: dict(target_peak, knee_frac, curve, src_peak)
    """
    w, h, fps = meta["width"], meta["height"], meta["fps"]
    ysz, csz = w * h, (w // 2) * (h // 2)
    frame_bytes = (ysz + 2 * csz) * 2
    dec = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-ss", f"{t0:.6f}", "-to", f"{t1:.6f}", "-i", src,
         "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-"],
        stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-",
         "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         "-metadata", f"comment=hdr-tool pipeline={color.PIPELINE_VERSION} "
                      f"curve={settings['curve']} peak={settings['target_peak']} "
                      f"knee={settings['knee_frac']}",
         dst],
        stdin=subprocess.PIPE)
    n = 0
    total = max(1, int(round((t1 - t0) * fps)))
    while True:
        buf = dec.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        a = np.frombuffer(buf, dtype="<u2")
        y = a[:ysz].reshape(h, w)
        cb = a[ysz:ysz + csz].reshape(h // 2, w // 2)
        cr = a[ysz + csz:].reshape(h // 2, w // 2)
        cb = np.repeat(np.repeat(cb, 2, axis=0), 2, axis=1)
        cr = np.repeat(np.repeat(cr, 2, axis=0), 2, axis=1)
        rgb_nits = ycbcr_to_rgb_nits(y, cb, cr, meta, transfer, primaries)
        lin = color.tonemap_frame(rgb_nits, primaries, settings["target_peak"],
                                  settings["knee_frac"], settings["curve"], settings["src_peak"])
        enc.stdin.write(color.sdr_encode(lin).tobytes())
        n += 1
        if progress:
            progress(n, total)
    dec.stdout.close()
    dec.wait()
    enc.stdin.close()
    enc.wait()
    if dec.returncode != 0:
        raise VideoError("解码进程异常退出")
    if enc.returncode != 0:
        raise VideoError("编码进程异常退出")
    return n
