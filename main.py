"""入口:
  python main.py                 启动 GUI
  python main.py --make-tests    生成测试片到 test_clips/
  python main.py --selftest      无头自检: 生成→解码→映射→导出→回读校验
"""
import os
import sys


def make_tests(outdir="test_clips"):
    from hdr_tool import testgen
    os.makedirs(outdir, exist_ok=True)
    for name, fn in (("gray_chart.mp4", testgen.make_gray_chart),
                     ("gradient_block.mp4", testgen.make_gradient_block)):
        path = os.path.join(outdir, name)
        print("生成", path, flush=True)
        fn(path)
    print("完成")


def selftest():
    import numpy as np
    from hdr_tool import color, testgen, verify, video

    os.makedirs("test_clips", exist_ok=True)
    src = "test_clips/gray_chart.mp4"
    if not os.path.exists(src):
        make_tests()

    meta = video.probe(src)
    transfer, why_t = video.resolve_transfer(meta, None)
    primaries, why_p = video.resolve_primaries(meta, None)
    src_peak, why_s = video.src_peak_nits(meta, transfer)
    print(f"[元数据] {transfer} ({why_t}) | {primaries} ({why_p}) | 峰值 {src_peak:.0f} ({why_s})")
    assert transfer == "smpte2084" and primaries == "bt2020"

    # 1. 灰阶读数验证: 解码源片, 采样已知亮度方块
    rgb_nits = video.decode_frame_nits(src, 1.0, meta, transfer, primaries)
    pts = testgen.chart_points(meta["width"], meta["height"])
    print("[灰阶读数] 标称nit -> 实测nit")
    for pt in pts[:12]:
        y = float(verify.sample_patch(rgb_nits, pt["x"], pt["y"]) @ color.LUMA_2020)
        rel_err = abs(y - pt["nits"]) / max(pt["nits"], 0.2)
        flag = "OK" if rel_err < 0.15 else f"偏差{rel_err:.0%}"
        print(f"  {pt['label']:>10} -> {y:10.2f}  {flag}")

    # 2. 两种曲线映射 + 告警统计
    settings = {"target_peak": 100.0, "knee_frac": 0.6, "curve": "A", "src_peak": src_peak}
    for curve in ("A", "B"):
        settings["curve"] = curve
        lin = color.tonemap_frame(rgb_nits, primaries, 100.0, 0.6, curve, src_peak)
        sdr8 = color.sdr_encode(lin)
        y_nits = rgb_nits @ color.LUMA_2020
        _, stats = color.highlight_classes(y_nits, sdr8, 60.0)
        print(f"[曲线{curve}] 亮部 {stats['highlight_pct']:.1f}% "
              f"可细分 {stats['separable_pct']:.1f}% 挤到上限 {stats['clipped_pct']:.1f}%")

    # 3. 导出 + 回读校验
    settings["curve"] = "A"
    out = "test_clips/sdr_out.mp4"
    n = video.export_sdr(src, out, meta, transfer, primaries, settings, 0.0, 2.0)
    print(f"[导出] {n} 帧 -> {out}")
    comment = verify.probe_comment(out)
    assert f"pipeline={color.PIPELINE_VERSION}" in comment, comment
    out_meta = video.probe(out)
    back = verify.readback_frame_rgb(out, 1.0, out_meta["width"], out_meta["height"])
    lin = color.tonemap_frame(rgb_nits, primaries, 100.0, 0.6, "A", src_peak)
    rows = verify.compare_points(pts, color.sdr_encode(lin), back)
    ok, bad = verify.check_order(rows)
    n_bad = sum(1 for r in rows if not r["ok"])
    print(f"[回读] 顺序 {'正常' if ok else '异常: ' + '; '.join(bad)}, "
          f"超差点 {n_bad}/{len(rows)} (容差 ±{verify.TOLERANCE_CODE} 码值)")
    for r in rows[:12]:
        print(f"  {r['label']:>10} 预览 {r['preview_code']:6.1f} 回读 {r['back_code']:6.1f} "
              f"Δ{r['delta']:+.1f} {'OK' if r['ok'] else '超差'}")
    assert ok and n_bad == 0
    print("自检通过")


def main():
    if "--make-tests" in sys.argv:
        make_tests()
        return
    if "--selftest" in sys.argv:
        selftest()
        return
    from PySide6.QtWidgets import QApplication
    from hdr_tool.app import MainWindow
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        win.open_file(sys.argv[1])
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
