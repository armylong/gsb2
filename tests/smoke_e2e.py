"""端到端冒烟: 生成测试片 -> 探测 -> 取帧 -> 导出 -> 逐帧核对.

直接用 python 运行 (非 pytest): .venv/bin/python tests/smoke_e2e.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import exporter, generator, media
from app.framesource import FrameSource
from app.timecode import RateMode, Timecode, format_tc, frame_to_tc, tc_to_frame

failures = []


def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), name, extra)
    if not cond:
        failures.append(name)


def run_case(tmp, mode, start_tc, seconds, tag):
    print(f"\n=== {tag}: {mode.value} 起始 {format_tc(start_tc, mode)} ===")
    clip = str(tmp / f"{tag}.mov")
    total = generator.generate_test_clip(clip, start_tc, mode, seconds, size=(320, 180))
    info = media.probe(clip)
    check(f"{tag} 内嵌时间码可读", info.embedded_timecode is not None, str(info.embedded_timecode))
    check(f"{tag} 帧数一致", info.frame_count == total, f"{info.frame_count} vs {total}")
    check(f"{tag} 恒定帧率", info.is_cfr, str(info.vfr_note))

    start_frame = tc_to_frame(start_tc, mode)
    with FrameSource(info) as src:
        # 头、中、尾各取一帧, 确认取帧数与生成数一致
        check(f"{tag} 首帧可取", src.frame(0) is not None)
        check(f"{tag} 末帧可取", src.frame(total - 1) is not None)
        check(f"{tag} 越界返回 None", src.frame(total) is None)
        # 后退取帧 (触发解码重启)
        check(f"{tag} 回跳取帧", src.frame(3) is not None)

    # 导出中间一段 (无损), 逐帧核对
    in_f, out_f = total // 3, total // 2
    out = str(tmp / f"{tag}_seg.mkv")
    res = exporter.export_segment(info, out, in_f, out_f, True, mode, start_tc, lossless=True)
    check(f"{tag} 导出帧数", res.count == out_f - in_f + 1)
    exp_first = format_tc(frame_to_tc(start_frame + in_f, mode), mode)
    check(f"{tag} 首帧时间码", res.first_tc == exp_first, res.first_tc)
    rep = exporter.verify_export(info, res)
    check(f"{tag} 逐帧核对", rep.ok, rep.note)

    # 不含出点的导出
    out2 = str(tmp / f"{tag}_seg2.mkv")
    res2 = exporter.export_segment(info, out2, in_f, out_f, False, mode, start_tc, lossless=True)
    check(f"{tag} 不含出点少一帧", res2.count == out_f - in_f)
    rep2 = exporter.verify_export(info, res2)
    check(f"{tag} 不含出点逐帧核对", rep2.ok, rep2.note)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="tccheck_"))
    print("工作目录:", tmp)
    # 25fps 跨午夜
    run_case(tmp, RateMode.NDF_25, Timecode(23, 59, 50, 0), 21, "midnight25")
    # 29.97 丢帧, 跨整分钟和整十分钟
    run_case(tmp, RateMode.DF_2997, Timecode(0, 0, 59, 28), 21, "dfminute")
    run_case(tmp, RateMode.DF_2997, Timecode(0, 9, 59, 0), 21, "dftenmin")
    # 29.97 不丢帧对照
    run_case(tmp, RateMode.NDF_2997, Timecode(0, 0, 59, 28), 10, "ndf2997")

    print()
    if failures:
        print("失败:", failures)
        sys.exit(1)
    print("全部通过")


if __name__ == "__main__":
    main()
