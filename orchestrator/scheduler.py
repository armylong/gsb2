"""调度器: 依赖就绪判定、全局并发、资源容量、超时、重试、取消、进程组清理。

所有子进程以独立进程组启动 (start_new_session=True), 超时/取消时对整个
进程组发信号, 保证子进程再派生的孙进程也不会遗留。
"""

import json
import os
import signal
import subprocess
import threading
import time
import traceback
from collections import defaultdict

POLL_INTERVAL = 0.2
KILL_GRACE = 2.0  # SIGTERM 后多久升级为 SIGKILL

TERMINAL_TASK = ("success", "failed", "blocked", "skipped", "cancelled", "carried", "unknown")


def _killpg(pid, sig):
    try:
        os.killpg(os.getpgid(pid), sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


class Scheduler:
    def __init__(self, db, data_dir, max_parallel=4, capacities=None, work_cwd=None):
        self.db = db
        self.data_dir = data_dir
        self.max_parallel = max_parallel
        self.capacities = dict(capacities or {})
        self.usage = defaultdict(int)
        self.procs = {}        # attempt_id -> 进程信息
        self.retry_after = {}  # run_task_id -> (就绪时间, 下一次 attempt_no)
        self.lock = threading.Lock()
        self.work_cwd = work_cwd or os.getcwd()
        self._stop = threading.Event()
        self._thread = None

    # ---------------- 生命周期 ----------------
    def start(self):
        self._thread = threading.Thread(target=self._loop, daemon=True, name="scheduler")
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        with self.lock:
            for info in list(self.procs.values()):
                _killpg(info["popen"].pid, signal.SIGKILL)
            for info in list(self.procs.values()):
                try:
                    info["popen"].wait(timeout=3)
                except Exception:
                    pass

    def _loop(self):
        while not self._stop.is_set():
            try:
                with self.lock:
                    self._reap()
                    self._dispatch()
                    self._finalize_runs()
            except Exception:
                traceback.print_exc()
            self._stop.wait(POLL_INTERVAL)

    # ---------------- 进程回收 ----------------
    def _reap(self):
        now = time.time()
        for attempt_id, info in list(self.procs.items()):
            p = info["popen"]
            if not info.get("killing"):
                if self.db.get_cancel_requested(info["run_id"]):
                    self._begin_kill(info, "cancelled", now)
                elif now >= info["deadline"]:
                    self._begin_kill(info, "timeout", now)
            rc = p.poll()
            if rc is None:
                if info.get("killing") and now - info["kill_at"] > KILL_GRACE:
                    _killpg(p.pid, signal.SIGKILL)
                    info["kill_at"] = now
                continue
            self._finish_attempt(attempt_id, info, rc, now)

    def _begin_kill(self, info, reason, now):
        info["killing"] = True
        info["kill_reason"] = reason
        info["kill_at"] = now
        _killpg(info["popen"].pid, signal.SIGTERM)

    def _finish_attempt(self, attempt_id, info, rc, now):
        del self.procs[attempt_id]
        try:
            info["log_fh"].close()
        except Exception:
            pass
        for rname, amount in info["needs"].items():
            self.usage[rname] -= amount

        reason = info.get("kill_reason")
        if reason == "cancelled":
            status, timed_out = "cancelled", False
        elif reason == "timeout":
            status, timed_out = "timeout", True
        elif rc == 0:
            status, timed_out = "success", False
        else:
            status, timed_out = "failed", False
        self.db.finish_attempt(attempt_id, status, exit_code=rc, timed_out=timed_out)

        rtid = info["run_task_id"]
        if status == "success":
            self.db.update_task_status(rtid, "success")
        elif status == "cancelled":
            self.db.update_task_status(rtid, "cancelled")
            self.retry_after.pop(rtid, None)
        else:
            tcfg = info["task_cfg"]
            if (info["attempt_no"] <= tcfg["retries"]
                    and not self.db.get_cancel_requested(info["run_id"])):
                # 还有重试额度: 延迟后重新派发, 旧进程已被杀干净
                self.retry_after[rtid] = (now + tcfg["retry_delay"], info["attempt_no"] + 1)
            else:
                self.db.update_task_status(rtid, "failed")

    # ---------------- 派发 ----------------
    def _dispatch(self):
        for run in self.db.list_running_runs():
            if run["cancel_requested"]:
                continue
            run_id = run["id"]
            tasks = self.db.get_run_tasks(run_id)
            by_name = {t["name"]: t for t in tasks}
            status = {t["name"]: t["status"] for t in tasks}
            cfgs = {t["name"]: json.loads(t["task_json"]) for t in tasks}

            # 阻塞传播: 上游失败/取消 -> 下游标记 blocked 并记录被谁阻塞
            causes = {}  # 任务名 -> 造成阻塞的失败任务列表
            for t in tasks:
                if t["status"] in ("blocked", "skipped") and t["blocked_by"]:
                    causes[t["name"]] = json.loads(t["blocked_by"])
            changed = True
            while changed:
                changed = False
                for t in tasks:
                    name = t["name"]
                    if status[name] != "pending":
                        continue
                    bad = []
                    for dep in cfgs[name]["depends_on"]:
                        ds = status.get(dep)
                        if ds in ("failed", "cancelled", "unknown"):
                            bad.append(dep)
                        elif ds in ("blocked", "skipped"):
                            bad.extend(causes.get(dep) or [dep])
                    if bad:
                        cause = sorted(set(bad))
                        causes[name] = cause
                        self.db.update_task_status(t["id"], "blocked", blocked_by=cause)
                        status[name] = "blocked"
                        changed = True

            # 首次派发
            for t in tasks:
                name = t["name"]
                if status[name] != "pending":
                    continue
                deps = cfgs[name]["depends_on"]
                if not all(status.get(d) in ("success", "carried") for d in deps):
                    continue
                if not self._try_start(run, t, cfgs[name], 1):
                    return  # 并发或资源占满, 下轮再来
                status[name] = "running"

            # 重试派发
            now = time.time()
            by_id = {t["id"]: t for t in tasks}
            for rtid, (ready_ts, next_no) in list(self.retry_after.items()):
                t = by_id.get(rtid)
                if t is None or t["run_id"] != run_id or now < ready_ts:
                    continue
                cfg = json.loads(t["task_json"])
                if not self._try_start(run, t, cfg, next_no):
                    return
                del self.retry_after[rtid]

    def _resources_fit(self, needs):
        return all(self.usage[r] + amount <= self.capacities.get(r, 0)
                   for r, amount in needs.items())

    def _try_start(self, run, task, tcfg, attempt_no):
        if len(self.procs) >= self.max_parallel:
            return False
        if not self._resources_fit(tcfg["needs"]):
            return False
        self._start_attempt(run, task, tcfg, attempt_no)
        return True

    def _start_attempt(self, run, task, tcfg, attempt_no):
        run_id = run["id"]
        run_dir = os.path.join(self.data_dir, "runs", "run_%d" % run_id)
        task_dir = os.path.join(run_dir, task["name"])
        os.makedirs(task_dir, exist_ok=True)
        log_path = os.path.join(task_dir, "attempt_%d.log" % attempt_no)

        cmd = tcfg["command"]
        for token, value in {
            "{run_id}": str(run_id),
            "{run_dir}": run_dir,
            "{task_dir}": task_dir,
            "{attempt}": str(attempt_no),
        }.items():
            cmd = cmd.replace(token, value)

        log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
        log_fh.write("# command: %s\n# attempt: %d  started: %s\n\n"
                     % (cmd, attempt_no, time.strftime("%Y-%m-%d %H:%M:%S")))
        log_fh.flush()

        attempt_id = self.db.create_attempt(task["id"], attempt_no, pid=0, log_path=log_path)
        try:
            env = dict(os.environ)
            env["ORCH_RUN_ID"] = str(run_id)
            env["ORCH_TASK"] = task["name"]
            env["ORCH_TASK_DIR"] = task_dir
            p = subprocess.Popen(
                cmd, shell=True, cwd=self.work_cwd,
                stdout=log_fh, stderr=subprocess.STDOUT,
                start_new_session=True, env=env)
        except Exception as e:
            log_fh.write("\n# 启动失败: %s\n" % e)
            log_fh.close()
            self.db.finish_attempt(attempt_id, "failed", exit_code=None)
            self.db.update_task_status(task["id"], "failed")
            return

        # 注意: 本方法在持有 self.lock 的调度循环里被调用, 不能再取 self.lock
        with self.db.lock, self.db.conn:
            self.db.conn.execute("UPDATE attempts SET pid=? WHERE id=?",
                                 (p.pid, attempt_id))
        self.db.update_task_status(task["id"], "running")
        for rname, amount in tcfg["needs"].items():
            self.usage[rname] += amount
        self.procs[attempt_id] = {
            "popen": p, "log_fh": log_fh,
            "run_id": run_id, "run_task_id": task["id"],
            "attempt_no": attempt_no, "task_cfg": tcfg,
            "needs": dict(tcfg["needs"]),
            "deadline": time.time() + tcfg["timeout"],
        }

    # ---------------- 运行收尾 ----------------
    def _finalize_runs(self):
        for run in self.db.list_running_runs():
            run_id = run["id"]
            has_proc = any(i["run_id"] == run_id for i in self.procs.values())
            tasks = self.db.get_run_tasks(run_id)
            task_ids = {t["id"] for t in tasks}
            has_retry = any(rtid in task_ids for rtid in self.retry_after)

            if run["cancel_requested"]:
                for t in tasks:
                    if t["status"] == "pending":
                        self.db.update_task_status(t["id"], "skipped")
                if not has_proc and not has_retry:
                    for t in tasks:
                        if t["status"] == "running":
                            self.db.update_task_status(t["id"], "cancelled")
                    for rtid in list(self.retry_after):
                        if rtid in task_ids:
                            del self.retry_after[rtid]
                    self.db.finish_run(run_id, "cancelled")
                continue

            if has_proc or has_retry:
                continue
            if any(t["status"] in ("pending", "running") for t in tasks):
                continue
            final = "failed" if any(t["status"] in ("failed", "blocked") for t in tasks) \
                else "success"
            self.db.finish_run(run_id, final)


def create_run(db, flow, kind="full"):
    """全新运行: 所有任务 pending, 记录完整配置快照。"""
    tasks = [(t.name, "pending", json.dumps(t.snapshot()), None, None)
             for t in flow.tasks.values()]
    return db.create_run(flow.name, kind,
                         config_json=json.dumps(flow.raw, ensure_ascii=False),
                         config_hash=flow.config_hash(), tasks=tasks)


def create_rerun(db, flow, source_run, roots, kind="rerun"):
    """从 source_run 重跑 roots 及其下游; 不相关的成功分支以 carried 继承。

    每次重跑都记录当时的完整配置; 若与来源运行配置不同, 标记 config_mixed,
    界面上明确提示这次运行混合了不同配置产生的结果。
    """
    source_run_id = source_run["id"]
    affected = flow.affected_set(roots)
    src_tasks = {t["name"]: t for t in db.get_run_tasks(source_run_id)}
    config_mixed = source_run["config_hash"] != flow.config_hash()

    tasks = []
    for name, task in flow.tasks.items():
        src = src_tasks.get(name)
        if name in affected or src is None:
            tasks.append((name, "pending", json.dumps(task.snapshot()), None, None))
        elif src["status"] == "success":
            tasks.append((name, "carried", src["task_json"], None, source_run_id))
        else:
            # 失败/阻塞等终态原样继承, 阻塞关系保持可见
            blocked_by = json.loads(src["blocked_by"]) if src["blocked_by"] else None
            tasks.append((name, src["status"], src["task_json"],
                          blocked_by, source_run_id))

    return db.create_run(
        flow.name, kind,
        config_json=json.dumps(flow.raw, ensure_ascii=False),
        config_hash=flow.config_hash(),
        source_run_id=source_run_id,
        rerun_root=",".join(sorted(roots)),
        config_mixed=config_mixed, tasks=tasks)
