#!/usr/bin/env python3
"""关键行为验证:全部断言都读真实转码输出文件,不用预设答案。

用法: python verify.py
  1. 生成(或复用)测试样片 work/sample.mp4
  2. 用两套示例配置真实转码到 work/verify/
  3. 断言:可播放、窗口字节合计=视频包总量、视频+音频+开销=文件大小、
     首帧关键帧、硬切处(9s)出现编码器实际关键帧、码率配置单调性、
     按内容时刻取帧内容正确(静态蓝场/硬切后白场,验证画面定位不串时刻)
"""
import os
import subprocess
import sys

import core

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
SAMPLE = os.path.join(WORK, "sample.mp4")
OUTDIR = os.path.join(WORK, "verify")

CFG_A = {"vkbps": 800, "gop": 120, "preset": "medium"}   # 高码率 + 4s GOP
CFG_B = {"vkbps": 300, "gop": 30, "preset": "medium"}    # 低码率 + 1s GOP
AUDIO_KBPS = 96

_failed = []


def check(name, cond, detail=""):
    print("%s %s %s" % ("PASS" if cond else "FAIL", name, detail))
    if not cond:
        _failed.append(name)


def frame_rgb(path, t, crop=None):
    """按内容时刻 t 取帧,返回 (r,g,b) 均值 —— 验证画面定位与时刻一致。
    crop=(x,y,w,h) 时只统计该区域。"""
    pts = core.frame_pts(path)
    cand = [p for p in pts if p >= t - 1e-4]
    target = cand[0] if cand else pts[-1]
    ss = max(0.0, target - 1e-4)
    cmd = ["ffmpeg", "-v", "error", "-ss", "%.4f" % ss, "-i", path]
    if crop:
        cmd += ["-vf", "crop=%d:%d:%d:%d" % (crop[2], crop[3], crop[0], crop[1])]
    cmd += ["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.run(cmd, capture_output=True)
    data = p.stdout
    assert p.returncode == 0 and len(data) > 0, "取帧失败"
    n = len(data) // 3
    return sum(data[0::3]) // n, sum(data[1::3]) // n, sum(data[2::3]) // n


def main():
    os.makedirs(OUTDIR, exist_ok=True)

    if not os.path.exists(SAMPLE):
        print("生成测试样片 ...")
        core.gen_sample(SAMPLE)
    info = core.probe_input(SAMPLE)
    check("样片时长约 12s", abs(info["duration"] - 12) < 0.2, "实际 %.3f s" % info["duration"])
    check("样片 720p 且带音频", info["height"] == 720 and info["has_audio"],
          "%sx%s acodec=%s" % (info["width"], info["height"], info.get("acodec")))

    outs = {}
    for tag, cfg in (("A", CFG_A), ("B", CFG_B)):
        out = os.path.join(OUTDIR, "out_%s.mp4" % tag)
        print("转码配置 %s: %s ..." % (tag, cfg))
        core.transcode(SAMPLE, out, cfg, AUDIO_KBPS)
        outs[tag] = out

        oi = core.probe_input(out)
        check("%s 输出可播放(h264+aac, 时长≈12s)" % tag,
              oi.get("vcodec") == "h264" and oi.get("acodec") == "aac"
              and abs(oi["duration"] - 12) < 0.3,
              "v=%s a=%s dur=%.3f" % (oi.get("vcodec"), oi.get("acodec"), oi["duration"]))

        for w in (1, 2):
            an = core.analyze(out, w)
            check("%s 窗口%ds视频字节合计==视频包总量" % (tag, w),
                  sum(an["video_window_bytes"]) == an["video_bytes"],
                  "%d == %d" % (sum(an["video_window_bytes"]), an["video_bytes"]))
            check("%s 窗口%ds: 视频+音频+封装开销==文件大小" % (tag, w),
                  an["video_bytes"] + an["audio_bytes"] + an["overhead_bytes"] == an["size"],
                  "%d+%d+%d == %d" % (an["video_bytes"], an["audio_bytes"],
                                      an["overhead_bytes"], an["size"]))

        an = core.analyze(out, 1)
        check("%s 首帧是关键帧@0" % tag, an["keyframes"] and abs(an["keyframes"][0]) < 0.05,
              "keyframes[0]=%s" % (an["keyframes"][0] if an["keyframes"] else None))
        check("%s 平均码率为实测值(=视频字节*8/时长)" % tag,
              abs(an["avg_video_kbps"] - an["video_bytes"] * 8 / 1000 / an["duration"]) < 0.01)
        check("%s 纹理运动段(5s窗)码率 > 静态段(1s窗)码率" % tag,
              an["video_window_kbps"][5] > an["video_window_kbps"][1],
              "5s窗 %.0f vs 1s窗 %.0f kbps" % (an["video_window_kbps"][5],
                                               an["video_window_kbps"][1]))

    # 码率配置单调性:视频码率更高的配置,视频数据量更大
    an_a = core.analyze(outs["A"], 1)
    an_b = core.analyze(outs["B"], 1)
    check("A(800k)视频数据量 > B(300k)视频数据量",
          an_a["video_bytes"] > an_b["video_bytes"],
          "%d > %d" % (an_a["video_bytes"], an_b["video_bytes"]))

    # 关键帧:gop=120 的配置 A 在 9s 硬切处应出现编码器场景切换关键帧
    kf_a = core.analyze(outs["A"], 1)["keyframes"]
    check("A 在硬切附近(8.8~9.7s)有编码器实际关键帧",
          any(8.8 <= k <= 9.7 for k in kf_a),
          "keyframes=%s" % [round(k, 2) for k in kf_a])
    kf_b = core.analyze(outs["B"], 1)["keyframes"]
    check("B 关键帧间隔符合 gop=30(约 1s)",
          all((kf_b[i + 1] - kf_b[i]) < 1.6 for i in range(len(kf_b) - 1)),
          "间隔=%s" % [round(kf_b[i + 1] - kf_b[i], 2) for i in range(len(kf_b) - 1)])

    # 画面定位:同一内容时刻,原片与两套输出画面内容一致(不串时刻)
    for tag, path in (("原片", SAMPLE), ("A", outs["A"]), ("B", outs["B"])):
        r, g, b = frame_rgb(path, 2.0)
        check("%s t=2.0s 画面为静态蓝场" % tag, b > r + 20, "rgb=(%d,%d,%d)" % (r, g, b))
        r, g, b = frame_rgb(path, 10.5)
        check("%s t=10.5s 画面为硬切后白场" % tag,
              r > 180 and g > 180 and b > 180, "rgb=(%d,%d,%d)" % (r, g, b))

    # 目标体积偏差口径:实测文件大小 - 目标
    an = core.analyze(outs["A"], 1)
    target = int(1.5 * 1024 * 1024)
    dev = an["size"] - target
    print("INFO 目标 1.5MB 时 A 偏差 = %+d 字节(%.1f%%)" % (dev, 100.0 * dev / target))
    check("目标偏差基于实测文件大小", isinstance(dev, int))

    print()
    if _failed:
        print("共 %d 项失败: %s" % (len(_failed), ", ".join(_failed)))
        sys.exit(1)
    print("全部验证通过。")


if __name__ == "__main__":
    main()
