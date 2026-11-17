"""JS 与 Python 两套插值实现的一致性校验（需要 node，缺失时跳过）。"""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from framer.keyframes import build_x_expression, interpolate

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "framer" / "static" / "keyframes.js"

NODE_DRIVER = r"""
const core = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
const out = cases.map((c) => ({
  x: core.interpolate(c.kfs, c.t, c.dw, c.cw, c.easing),
  expr: core.buildXExpression(c.kfs, c.dw, c.cw, c.easing),
  clamp: core.clampX(c.raw, c.dw, c.cw),
}));
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "未安装 node，跳过 JS 一致性测试")
class TestParity(unittest.TestCase):
    def test_matches_python(self):
        dw, cw, dh = 1280, 404, 720
        scenarios = [
            [{"t": 0, "x": 0}, {"t": 2, "x": 200}, {"t": 4, "x": 0}],
            [{"t": 1, "x": 10}, {"t": 3.5, "x": 874}],
            [{"t": 0, "x": 437}],
            [{"t": 0, "x": 0}, {"t": 1, "x": 100},
             {"t": 2, "x": 300}, {"t": 5, "x": 5}],
        ]
        cases = []
        for kfs in scenarios:
            for t in [i * 0.137 for i in range(40)]:
                for easing in ("linear", "smoothstep"):
                    cases.append({
                        "kfs": kfs, "t": t, "dw": dw, "cw": cw,
                        "easing": easing, "raw": t * 50 - 100,
                    })
        proc = subprocess.run(
            ["node", "-e", NODE_DRIVER, str(JS), json.dumps(cases)],
            capture_output=True, text=True, check=True,
        )
        js_out = json.loads(proc.stdout)
        for case, got in zip(cases, js_out):
            py_x = interpolate(case["kfs"], case["t"], dw, cw, case["easing"])
            self.assertEqual(got["x"], py_x,
                             f"插值不一致 case={case} js={got['x']} py={py_x}")
            py_expr = build_x_expression(
                case["kfs"], dw, cw, case["easing"])
            self.assertEqual(got["expr"], py_expr, "ffmpeg 表达式字符串不一致")
            from framer.keyframes import clamp_x
            self.assertEqual(got["clamp"], clamp_x(case["raw"], dw, cw))


if __name__ == "__main__":
    unittest.main()
