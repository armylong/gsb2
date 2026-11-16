"""HTTP 服务: 只提供本地页面与查看/启动入口, 命令全部来自本地配置文件,
不接受任何远程命令文本。

接口:
  GET  /                              页面
  GET  /api/flows                     流程列表 (含校验错误)
  POST /api/runs          {flow}      启动一次全新运行
  GET  /api/runs                      运行列表
  GET  /api/runs/{id}                 运行详情 (任务 + 尝试)
  POST /api/runs/{id}/cancel          取消运行
  POST /api/runs/{id}/rerun  {task}   重跑某失败节点及受影响下游
  POST /api/runs/{id}/recover         崩溃恢复: 确认重跑结果未知的任务及下游
  GET  /api/attempts/{id}/log?offset= 增量读取日志
"""

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import ConfigError, load_flow
from .db import DB
from .scheduler import Scheduler, create_run, create_rerun

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def _ts(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if t else None


class App:
    def __init__(self, flows_dir, data_dir, max_parallel=None, work_cwd=None):
        self.flows_dir = flows_dir
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.db = DB(os.path.join(data_dir, "orchestrator.db"))
        self.interrupted_count = self.db.recover_interrupted()
        self.flows, self.flow_errors = self._load_flows()
        capacities = {}
        global_max = 1
        for f in self.flows.values():
            for r, cap in f.resources.items():
                capacities[r] = max(capacities.get(r, 0), cap)
            global_max = max(global_max, f.max_parallel)
        if max_parallel:
            global_max = max_parallel
        self.scheduler = Scheduler(self.db, data_dir, max_parallel=global_max,
                                   capacities=capacities, work_cwd=work_cwd)

    def _load_flows(self):
        flows, errors = {}, {}
        if os.path.isdir(self.flows_dir):
            for fn in sorted(os.listdir(self.flows_dir)):
                if not fn.endswith(".json"):
                    continue
                path = os.path.join(self.flows_dir, fn)
                try:
                    flow = load_flow(path)
                    flows[flow.name] = flow
                except ConfigError as e:
                    errors[fn] = str(e)
        return flows, errors

    def reload_flows(self):
        self.flows, self.flow_errors = self._load_flows()
        capacities = {}
        for f in self.flows.values():
            for r, cap in f.resources.items():
                capacities[r] = max(capacities.get(r, 0), cap)
        self.scheduler.capacities = capacities

    # ---------- 视图数据 ----------
    def flows_view(self):
        out = []
        for name, f in sorted(self.flows.items()):
            out.append({
                "name": name,
                "max_parallel": f.max_parallel,
                "resources": f.resources,
                "config_hash": f.config_hash(),
                "tasks": [{
                    "name": t.name, "depends_on": t.depends_on,
                    "timeout": t.timeout, "retries": t.retries, "needs": t.needs,
                } for t in f.tasks.values()],
            })
        return {"flows": out, "errors": self.flow_errors,
                "capacities": self.scheduler.capacities,
                "max_parallel": self.scheduler.max_parallel,
                "usage": dict(self.scheduler.usage)}

    def run_summary(self, run):
        tasks = self.db.get_run_tasks(run["id"])
        counts = {}
        for t in tasks:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
        return {
            "id": run["id"], "flow_name": run["flow_name"], "kind": run["kind"],
            "status": run["status"], "source_run_id": run["source_run_id"],
            "rerun_root": run["rerun_root"], "config_hash": run["config_hash"],
            "config_mixed": bool(run["config_mixed"]),
            "cancel_requested": bool(run["cancel_requested"]),
            "created_at": _ts(run["created_at"]), "finished_at": _ts(run["finished_at"]),
            "task_counts": counts,
        }

    def run_detail(self, run_id):
        run = self.db.get_run(run_id)
        if not run:
            return None
        detail = self.run_summary(run)
        tasks = []
        for t in self.db.get_run_tasks(run_id):
            attempts = []
            for a in self.db.get_attempts(t["id"]):
                size = None
                if a["log_path"] and os.path.exists(a["log_path"]):
                    size = os.path.getsize(a["log_path"])
                attempts.append({
                    "id": a["id"], "attempt_no": a["attempt_no"], "status": a["status"],
                    "exit_code": a["exit_code"], "timed_out": bool(a["timed_out"]),
                    "started_at": _ts(a["started_at"]), "ended_at": _ts(a["ended_at"]),
                    "log_size": size,
                })
            tasks.append({
                "id": t["id"], "name": t["name"], "status": t["status"],
                "blocked_by": json.loads(t["blocked_by"]) if t["blocked_by"] else None,
                "source_run_id": t["source_run_id"],
                "task": json.loads(t["task_json"]),
                "attempts": attempts,
            })
        detail["tasks"] = tasks
        detail["usage"] = dict(self.scheduler.usage)
        detail["capacities"] = self.scheduler.capacities
        return detail

    # ---------- 操作 ----------
    def start_run(self, flow_name):
        flow = self.flows.get(flow_name)
        if not flow:
            raise ConfigError("流程不存在或配置校验失败: %s" % flow_name)
        return create_run(self.db, flow)

    def cancel_run(self, run_id):
        run = self.db.get_run(run_id)
        if not run:
            raise ConfigError("运行 #%d 不存在" % run_id)
        if run["status"] != "running":
            raise ConfigError("运行 #%d 已结束, 无法取消" % run_id)
        self.db.set_cancel(run_id)

    def rerun_task(self, run_id, task_name):
        run = self.db.get_run(run_id)
        if not run:
            raise ConfigError("运行 #%d 不存在" % run_id)
        if run["status"] == "running":
            raise ConfigError("运行 #%d 仍在进行, 结束后再重跑" % run_id)
        flow = self.flows.get(run["flow_name"])
        if not flow:
            raise ConfigError("流程 %s 当前配置不可用, 无法重跑" % run["flow_name"])
        if task_name not in flow.tasks:
            raise ConfigError("任务 %s 不在当前配置中" % task_name)
        return create_rerun(self.db, flow, run, [task_name], kind="rerun")

    def recover_run(self, run_id):
        run = self.db.get_run(run_id)
        if not run:
            raise ConfigError("运行 #%d 不存在" % run_id)
        if run["status"] != "interrupted":
            raise ConfigError("运行 #%d 不是中断状态, 无需恢复" % run_id)
        flow = self.flows.get(run["flow_name"])
        if not flow:
            raise ConfigError("流程 %s 当前配置不可用, 无法恢复" % run["flow_name"])
        unknown = [t["name"] for t in self.db.get_run_tasks(run_id)
                   if t["status"] == "unknown"]
        if not unknown:
            raise ConfigError("运行 #%d 没有结果未知的任务" % run_id)
        return create_rerun(self.db, flow, run, unknown, kind="recover")


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalOrchestrator/1.0"

        def log_message(self, fmt, *args):
            pass

        def _send_json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, e, code=400):
            self._send_json({"error": str(e)}, code)

        def _read_body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except json.JSONDecodeError:
                return {}

        def do_GET(self):
            path, _, query = self.path.partition("?")
            if path == "/":
                with open(os.path.join(WEB_DIR, "index.html"), "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/flows":
                app.reload_flows()
                self._send_json(app.flows_view())
                return
            if path == "/api/runs":
                self._send_json({"runs": [app.run_summary(r) for r in app.db.list_runs()]})
                return
            m = re.fullmatch(r"/api/runs/(\d+)", path)
            if m:
                detail = app.run_detail(int(m.group(1)))
                if detail is None:
                    self._send_json({"error": "运行不存在"}, 404)
                else:
                    self._send_json(detail)
                return
            m = re.fullmatch(r"/api/attempts/(\d+)/log", path)
            if m:
                offset = 0
                for part in query.split("&"):
                    if part.startswith("offset="):
                        try:
                            offset = max(0, int(part[7:]))
                        except ValueError:
                            pass
                self._attempt_log(int(m.group(1)), offset)
                return
            self._send_json({"error": "not found"}, 404)

        def _attempt_log(self, attempt_id, offset):
            row = None
            with app.db.lock:
                row = app.db.conn.execute(
                    "SELECT a.*, rt.run_id FROM attempts a"
                    " JOIN run_tasks rt ON rt.id=a.run_task_id WHERE a.id=?",
                    (attempt_id,)).fetchone()
            if not row or not row["log_path"] or not os.path.exists(row["log_path"]):
                self._send_json({"content": "", "offset": offset, "size": 0,
                                 "status": row["status"] if row else "missing"})
                return
            size = os.path.getsize(row["log_path"])
            with open(row["log_path"], "rb") as f:
                f.seek(min(offset, size))
                content = f.read().decode("utf-8", errors="replace")
            self._send_json({"content": content, "offset": size, "size": size,
                             "status": row["status"]})

        def do_POST(self):
            path = self.path.split("?")[0]
            body = self._read_body()
            try:
                if path == "/api/runs":
                    run_id = app.start_run(body.get("flow", ""))
                    self._send_json({"run_id": run_id})
                    return
                m = re.fullmatch(r"/api/runs/(\d+)/cancel", path)
                if m:
                    app.cancel_run(int(m.group(1)))
                    self._send_json({"ok": True})
                    return
                m = re.fullmatch(r"/api/runs/(\d+)/rerun", path)
                if m:
                    run_id = app.rerun_task(int(m.group(1)), body.get("task", ""))
                    self._send_json({"run_id": run_id})
                    return
                m = re.fullmatch(r"/api/runs/(\d+)/recover", path)
                if m:
                    run_id = app.recover_run(int(m.group(1)))
                    self._send_json({"run_id": run_id})
                    return
                self._send_json({"error": "not found"}, 404)
            except ConfigError as e:
                self._send_error_json(e)
            except Exception as e:  # 兜底, 不让单个请求打挂服务
                self._send_error_json(e, 500)

    return Handler


def serve(port, flows_dir, data_dir, max_parallel=None, work_cwd=None):
    app = App(flows_dir, data_dir, max_parallel=max_parallel, work_cwd=work_cwd)
    app.scheduler.start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    if app.interrupted_count:
        print("检测到 %d 次上次未正常结束的运行, 已标记为 interrupted,"
              " 其中运行中的任务结果未知, 请在页面确认后重跑。" % app.interrupted_count)
    print("任务编排服务已启动: http://127.0.0.1:%d" % port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.scheduler.stop()
        httpd.server_close()
