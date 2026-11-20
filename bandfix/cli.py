"""命令行:生成样例 / 无界面导出 / 核对。

  python -m bandfix.cli sample  --outdir samples
  python -m bandfix.cli export  --src samples/defect.mkv --dst out.mkv \
      --band 168 184 --method temporal --strength 0.85 --radius 2
  python -m bandfix.cli verify  --export out.mkv --src samples/defect.mkv \
      --band 168 184 --gt samples/clean.mkv
"""
from __future__ import annotations

import argparse
import json
import sys


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="bandfix", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample", help="生成测试片(含瑕疵片+干净真值+音轨)")
    s.add_argument("--outdir", default="samples")

    e = sub.add_parser("export", help="按参数修复整片(无损 mkv,音轨拷贝)")
    e.add_argument("--src", required=True)
    e.add_argument("--dst", required=True)
    e.add_argument("--band", nargs=2, type=int, required=True, metavar=("Y0", "Y1"))
    e.add_argument("--method", choices=["spatial", "temporal"], default="temporal")
    e.add_argument("--strength", type=float, default=0.85)
    e.add_argument("--radius", type=int, default=2)
    e.add_argument("--cut-thresh", type=float, default=0.15)
    e.add_argument("--no-audio", action="store_true")

    v = sub.add_parser("verify", help="重读导出,核对时长/带外/参考误差")
    v.add_argument("--export", required=True)
    v.add_argument("--src", required=True)
    v.add_argument("--band", nargs=2, type=int, required=True, metavar=("Y0", "Y1"))
    v.add_argument("--gt", default=None, help="干净真值视频(可选,用于参考误差)")
    v.add_argument("--tol", type=int, default=0, help="带外容差(无损导出应为0)")

    args = p.parse_args(argv)

    if args.cmd == "sample":
        from .samplegen import generate
        info = generate(args.outdir)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        print(f"\n瑕疵带: y=[{info['band'][0]}, {info['band'][1]}), "
              f"切镜帧: {info['cut_frame']}, 共 {info['frames']} 帧")
        return 0

    if args.cmd == "export":
        from .exporter import export_video
        info = export_video(args.src, args.dst, *args.band,
                            method=args.method, strength=args.strength,
                            radius=args.radius, cut_thresh=args.cut_thresh,
                            audio=not args.no_audio,
                            progress=lambda d, t: print(f"\r{d}/{t}", end="", flush=True))
        print("\n" + json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "verify":
        from .verify import verify, format_report
        res = verify(args.export, args.src, *args.band, gt=args.gt, tol=args.tol)
        print(format_report(res))
        return 0 if res["ok"] else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
