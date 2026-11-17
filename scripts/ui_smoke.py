"""用 Chrome DevTools Protocol 驱动网页 UI 的冒烟测试。

流程: 打开页面 -> 生成样例 -> 等待分析 -> 校验工作台出现 ->
调参 -> 等待预览/图表/裁切表渲染 -> 导出 -> 截图。
仅用于本机验证, 不属于产品代码。
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request

import websocket  # websocket-client

URL = "http://127.0.0.1:8841/"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def wait_port(proc):
    # 先等页面服务, 再等 Chrome 调试端口 (无头 Chrome 启动较慢)
    for _ in range(40):
        try:
            urllib.request.urlopen(URL, timeout=1)
            break
        except Exception:
            time.sleep(0.5)
    for _ in range(60):
        try:
            json.load(urllib.request.urlopen(
                "http://127.0.0.1:9222/json/version", timeout=1))
            return
        except Exception:
            time.sleep(0.5)
    proc.kill()
    raise RuntimeError("Chrome 调试端口未就绪")


def cdp_eval(ws, expr, await_promise=False):
    mid = next(cdp_eval.i)
    ws.send(json.dumps({
        "id": mid, "method": "Runtime.evaluate",
        "params": {"expression": expr, "returnByValue": True,
                   "awaitPromise": await_promise},
    }))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg["result"].get("result", {}).get("value")


cdp_eval.i = iter(range(1, 10_000))


def main(shot_path: str) -> None:
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
         "--remote-debugging-port=9222", "--window-size=1500,1700",
         "--user-data-dir=/tmp/cdp-stab-smoke", URL],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_port(proc)
        tabs = json.load(urllib.request.urlopen(
            "http://127.0.0.1:9222/json"))
        ws_url = tabs[0]["webSocketDebuggerUrl"]
        ws = websocket.create_connection(ws_url, timeout=30)
        cdp_eval(ws, "1+1")

        # 收集页面错误
        cdp_eval(ws, """
          window.__errs=[];
          window.addEventListener('error',e=>__errs.push(e.message));
        """)

        # 1. 点击生成样例
        cdp_eval(ws, "document.getElementById('sampleBtn').click()")
        # 轮询工作台出现
        ok = False
        for _ in range(60):
            visible = cdp_eval(
                ws, "getComputedStyle(document.getElementById('workPanel')"
                    ").display !== 'none'")
            if visible:
                ok = True
                break
            time.sleep(1)
        assert ok, "工作台未出现"
        print("[1] 样例生成并分析完成, 工作台显示")

        info = cdp_eval(ws, "document.getElementById('mediaInfo').textContent")
        print("    媒体信息:", info)
        cuts = cdp_eval(ws, "JSON.stringify(state.cuts)")
        print("    自动切点:", cuts)

        # 2. 改 sigma, 等待几何数据
        cdp_eval(ws, """
          const sl=document.getElementById('sigma');
          sl.value=12; sl.dispatchEvent(new Event('input'));
        """)
        for _ in range(40):
            n = cdp_eval(ws, "state.geo ? state.geo.frames.length : 0")
            if n == 360:
                break
            time.sleep(0.5)
        print("[2] 调参后几何数据帧数:",
              cdp_eval(ws, "state.geo.frames.length"),
              "sigma=", cdp_eval(ws, "state.geo.sigma"))

        # 等预览渲染完成
        for _ in range(40):
            ps = cdp_eval(ws, """
                (async()=>{const r=await fetch('/api/preview/'+state.taskId);
                 return (await r.json()).status;})()""", await_promise=True)
            if ps == "done":
                break
            time.sleep(0.5)
        print("    预览状态:", ps)

        # 3. 校验图表与裁切表
        chart_px = cdp_eval(ws, """
            (()=>{const c=document.getElementById('pathChart');
             const x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
             return Array.from(new Set(x.filter(v=>v>0))).length;})()""")
        rows = cdp_eval(
            ws, "document.querySelectorAll('#cropTable tbody tr').length")
        print(f"[3] 路径图非空色彩数={chart_px}, 裁切表镜头行数={rows}")
        assert chart_px > 10 and rows == 2

        # 切换通道
        cdp_eval(ws, "document.querySelector('[data-ch=angle]').click()")
        time.sleep(0.5)
        print("    已切换到旋转通道")

        # 4. 逐帧
        cdp_eval(ws, "document.getElementById('nextBtn').click()")
        cdp_eval(ws, "document.getElementById('nextBtn').click()")
        label = cdp_eval(ws, "document.getElementById('frameLabel').textContent")
        print("[4] 逐帧后:", label)
        assert "帧 2/" in label

        # 5. 导出
        cdp_eval(ws, "document.getElementById('exportBtn').click()")
        for _ in range(60):
            txt = cdp_eval(ws, "document.getElementById('exportState').textContent")
            if "完成" in txt:
                break
            time.sleep(1)
        print("[5] 导出:", txt)
        assert "完成" in txt

        # 6. 截图
        cdp_eval(ws, "window.scrollTo(0,0); new Promise(r=>setTimeout(r,500))",
                 await_promise=True)
        msg_id = 9999
        ws.send(json.dumps({"id": msg_id, "method": "Page.captureScreenshot",
                            "params": {"format": "png"}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == msg_id:
                data = m["result"]["data"]
                break
        with open(shot_path, "wb") as f:
            f.write(base64.b64decode(data))
        print("[6] 截图已保存:", shot_path)

        errs = cdp_eval(ws, "JSON.stringify(window.__errs)")
        print("[7] 页面运行时错误:", errs)
        assert errs == "[]", f"页面有JS错误: {errs}"
        print("\n全部 UI 冒烟检查通过")
    finally:
        proc.terminate()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "workspace/ui_smoke.png")
