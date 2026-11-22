"""命令行入口: synth / encode / stats / verify / export / corrupt / play"""
import argparse
import json
import sys


def main(argv=None):
    ap = argparse.ArgumentParser(prog="blockvid", description="块式录屏草稿回放实验工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("synth", help="生成合成测试短片(移动小方块)")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--seconds", type=float, default=5)

    p = sub.add_parser("encode", help="把视频编码成 .bvd")
    p.add_argument("src")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--block-w", type=int, default=64)
    p.add_argument("--block-h", type=int, default=64)
    p.add_argument("--keyint", type=int, default=30)
    p.add_argument("--max-seconds", type=float, default=30.0)

    p = sub.add_parser("stats", help="查看 .bvd 存储统计")
    p.add_argument("bvd")

    p = sub.add_parser("verify", help="与源视频逐像素核对(无损校验)")
    p.add_argument("bvd")
    p.add_argument("src")

    p = sub.add_parser("export", help="导出还原帧 PNG 做核对")
    p.add_argument("bvd")
    p.add_argument("-o", "--out-dir", required=True)
    p.add_argument("--frames", required=True,
                   help="帧号, 逗号分隔或 a-b 区间, 如 0,10,20-25")
    p.add_argument("--src", help="同时导出源帧并对比")

    p = sub.add_parser("corrupt", help="生成损坏副本做故障演示")
    p.add_argument("bvd")
    p.add_argument("--mode", choices=["zero", "truncate"], default="zero")

    p = sub.add_parser("play", help="打开 PySide6 图形界面")
    p.add_argument("bvd", nargs="?")

    args = ap.parse_args(argv)

    if args.cmd == "synth":
        from .synth import make_synth
        make_synth(args.out, args.width, args.height, args.fps, args.seconds)
        print("已生成:", args.out)
    elif args.cmd == "encode":
        from .encoder import encode
        stats = encode(args.src, args.out, args.block_w, args.block_h,
                       args.keyint, args.max_seconds)
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    elif args.cmd == "stats":
        from .decoder import Decoder
        print(json.dumps(Decoder(args.bvd).stats(), indent=2,
                         ensure_ascii=False))
    elif args.cmd == "verify":
        from .verify import verify
        rep = verify(args.bvd, args.src)
        print(json.dumps(rep, indent=2, ensure_ascii=False))
        if rep["mismatch"] or rep["corrupt"]:
            sys.exit(1)
        print(f"OK: {rep['total']} 帧全部逐像素一致")
    elif args.cmd == "export":
        from .verify import export_frames
        indices = []
        for part in args.frames.split(","):
            if "-" in part:
                a, b = part.split("-")
                indices.extend(range(int(a), int(b) + 1))
            else:
                indices.append(int(part))
        rows = export_frames(args.bvd, args.out_dir, indices, args.src)
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    elif args.cmd == "corrupt":
        from .synth import make_corrupt_copy
        out, idx = make_corrupt_copy(args.bvd, mode=args.mode)
        print(f"已生成损坏副本: {out} (破坏了第 {idx} 帧的记录)")
    elif args.cmd == "play":
        from .player import run
        run(args.bvd)


if __name__ == "__main__":
    main()
