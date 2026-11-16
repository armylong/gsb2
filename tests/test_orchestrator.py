"""自动化测试: 配置校验、依赖调度、失败阻塞、重试留痕、超时杀进程组、
取消、崩溃恢复、节点重跑与结果继承。

运行: python3 -m unittest discover -s tests -v
"""

import json
import os
import shlex
import shutil
import signal
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from orchestrator.config import ConfigError, validate_flow
from orchestrator.db import DB
from orchestrator.scheduler import Scheduler, create_run, create_rerun

PY = sys.executable


def cmd(script):
    return "%s -c %s" % (shlex.quote(PY), shlex.quote(script))


def task(name, script, deps=None, timeout=10, retries=0, needs=None, retry_delay=0.2):
    return {
        "name": name, "command": cmd(script), "timeout": timeout,
        "retries": retries, "retry_delay": retry_delay,
        "needs": needs or {}, "depends_on": deps or [],
    }


def flow_dict(tasks, resources=None, max_parallel=4):
    return {"name": "test_flow", "settings": {"max_parallel": max_parallel},
            "resources": resources or {}, "tasks": tasks}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="orch_test_")
        self.db = DB(os.path.join(self.tmp, "test.db"))
        self.sched = None

    def tearDown(self):
        if self.sched:
            self.sched.stop()
        self.db.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_scheduler(self, flow, max_parallel=4):
        self.sched = Scheduler(self.db, self.tmp, max_parallel=max_parallel,
                               capacities=flow.resources, work_cwd=self.tmp)
        self.sched.start()
        return self.sched

    def wait_run(self, run_id, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            run = self.db.get_run(run_id)
            if run["status"] != "running":
                return run
            time.sleep(0.1)
        self.fail("运行 #%d 超时未结束" % run_id)

    def task_map(self, run_id):
        return {t["name"]: t for t in self.db.get_run_tasks(run_id)}


class TestConfig(Base):
    def test_missing_dependency(self):
        with self.assertRaisesRegex(ConfigError, "不存在的任务"):
            validate_flow(flow_dict([task("a", "pass", deps=["ghost"])]))

    def test_cycle(self):
        with self.assertRaisesRegex(ConfigError, "环"):
            validate_flow(flow_dict([
                task("a", "pass", deps=["b"]),
                task("b", "pass", deps=["a"]),
            ]))

    def test_impossible_resource(self):
        with self.assertRaisesRegex(ConfigError, "永远无法满足"):
            validate_flow(flow_dict(
                [task("a", "pass", needs={"api_quota": 5})],
                resources={"api_quota": 2}))

    def test_unknown_resource(self):
        with self.assertRaisesRegex(ConfigError, "未定义的资源"):
            validate_flow(flow_dict([task("a", "pass", needs={"gpu": 1})]))

    def test_valid_flow(self):
        f = validate_flow(flow_dict(
            [task("a", "pass"), task("b", "pass", deps=["a"], needs={"q": 1})],
            resources={"q": 2}))
        self.assertEqual(f.config_hash(), f.config_hash())
        self.assertEqual(f.affected_set(["a"]), {"a", "b"})


class TestScheduler(Base):
    def test_dependency_order_and_success(self):
        flow = validate_flow(flow_dict([
            task("a", "print('a')"),
            task("b", "print('b')", deps=["a"]),
            task("c", "print('c')", deps=["a"]),
            task("d", "print('d')", deps=["b", "c"]),
        ]))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "success")
        tm = self.task_map(run_id)
        self.assertTrue(all(t["status"] == "success" for t in tm.values()))
        started = {}
        for name, t in tm.items():
            started[name] = self.db.get_attempts(t["id"])[0]["started_at"]
        self.assertLess(started["a"], started["b"])
        self.assertLess(started["a"], started["c"])
        self.assertLessEqual(max(started["b"], started["c"]), started["d"])

    def test_failure_blocks_downstream_not_failed(self):
        flow = validate_flow(flow_dict([
            task("bad", "import sys; sys.exit(1)"),
            task("down", "print('x')", deps=["bad"]),
            task("down2", "print('y')", deps=["down"]),
            task("ok", "print('z')"),
        ]))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "failed")
        tm = self.task_map(run_id)
        self.assertEqual(tm["bad"]["status"], "failed")
        self.assertEqual(tm["down"]["status"], "blocked")
        self.assertEqual(json.loads(tm["down"]["blocked_by"]), ["bad"])
        self.assertEqual(tm["down2"]["status"], "blocked")
        self.assertEqual(json.loads(tm["down2"]["blocked_by"]), ["bad"])
        self.assertEqual(tm["ok"]["status"], "success")

    def test_retry_keeps_all_attempts(self):
        state = os.path.join(self.tmp, "flaky.state")
        script = (
            "import sys\n"
            "if not __import__('os').path.exists(%r):\n"
            "    open(%r, 'w').write('x'); sys.exit(1)\n"
        ) % (state, state)
        flow = validate_flow(flow_dict([task("flaky", script, retries=2)]))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "success")
        t = self.task_map(run_id)["flaky"]
        attempts = self.db.get_attempts(t["id"])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["status"], "failed")   # 第一次失败被保留
        self.assertEqual(attempts[1]["status"], "success")
        self.assertNotEqual(attempts[0]["log_path"], attempts[1]["log_path"])
        for a in attempts:
            self.assertTrue(os.path.exists(a["log_path"]))

    def test_retry_exhausted_fails(self):
        flow = validate_flow(flow_dict(
            [task("always_bad", "import sys; sys.exit(3)", retries=1)]))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "failed")
        t = self.task_map(run_id)["always_bad"]
        attempts = self.db.get_attempts(t["id"])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["exit_code"], 3)

    def test_timeout_kills_process_group(self):
        # 任务派生一个子进程后一起睡眠; 超时后整个进程组都必须消失
        script = ("import subprocess, sys, time\n"
                  "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\n"
                  "time.sleep(300)\n")
        flow = validate_flow(flow_dict([task("slow", script, timeout=1)]))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "failed")
        t = self.task_map(run_id)["slow"]
        a = self.db.get_attempts(t["id"])[0]
        self.assertEqual(a["status"], "timeout")
        self.assertEqual(a["timed_out"], 1)
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError):
            os.killpg(a["pid"], 0)  # 整个进程组都不存在了

    def test_resource_capacity_serializes(self):
        flow = validate_flow(flow_dict(
            [task("h1", "import time; time.sleep(0.6)", needs={"q": 2}),
             task("h2", "import time; time.sleep(0.6)", needs={"q": 2})],
            resources={"q": 2}))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "success")
        tm = self.task_map(run_id)
        a1 = self.db.get_attempts(tm["h1"]["id"])[0]
        a2 = self.db.get_attempts(tm["h2"]["id"])[0]
        # 容量 2, 各占 2: 必须串行, 时间区间不重叠
        self.assertTrue(a1["ended_at"] <= a2["started_at"]
                        or a2["ended_at"] <= a1["started_at"])

    def test_cancel_kills_and_skips(self):
        flow = validate_flow(flow_dict([
            task("long", "import time; time.sleep(300)"),
            task("later", "print('x')", deps=["long"]),
        ]))
        self.make_scheduler(flow)
        run_id = create_run(self.db, flow)
        deadline = time.time() + 10
        while time.time() < deadline:
            tm = self.task_map(run_id)
            if tm["long"]["status"] == "running":
                break
            time.sleep(0.1)
        else:
            self.fail("任务未进入运行态")
        pid = self.db.get_attempts(tm["long"]["id"])[0]["pid"]
        self.db.set_cancel(run_id)
        run = self.wait_run(run_id)
        self.assertEqual(run["status"], "cancelled")
        tm = self.task_map(run_id)
        self.assertEqual(tm["long"]["status"], "cancelled")
        self.assertEqual(tm["later"]["status"], "skipped")
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError):
            os.killpg(pid, 0)
        # 资源已释放
        self.assertEqual(sum(self.sched.usage.values()), 0)

    def test_crash_recovery_marks_unknown(self):
        flow = validate_flow(flow_dict([task("a", "print(1)")]))
        run_id = create_run(self.db, flow)
        # 模拟崩溃现场: 任务和尝试停留在 running
        tid = self.db.add_run_task  # noqa - 仅防止误删
        t = self.task_map(run_id)["a"]
        self.db.update_task_status(t["id"], "running")
        self.db.create_attempt(t["id"], 1, pid=12345, log_path="/nonexistent")
        n = self.db.recover_interrupted()
        self.assertEqual(n, 1)
        run = self.db.get_run(run_id)
        self.assertEqual(run["status"], "interrupted")
        t = self.task_map(run_id)["a"]
        self.assertEqual(t["status"], "unknown")  # 绝不能算成功
        a = self.db.get_attempts(t["id"])[0]
        self.assertEqual(a["status"], "unknown")

    def test_recover_rerun_unknown_and_downstream(self):
        flow = validate_flow(flow_dict([
            task("a", "print('a')"),
            task("b", "print('b')", deps=["a"]),
            task("c", "print('c')"),
        ]))
        run_id = create_run(self.db, flow)
        tm = self.task_map(run_id)
        # 构造: a 结果未知, b 等待中, c 已成功
        self.db.update_task_status(tm["a"]["id"], "unknown")
        self.db.update_task_status(tm["c"]["id"], "success")
        self.db.finish_run(run_id, "interrupted")
        run2 = create_rerun(self.db, flow, self.db.get_run(run_id), ["a"], kind="recover")
        tm2 = self.task_map(run2)
        self.assertEqual(tm2["a"]["status"], "pending")
        self.assertEqual(tm2["b"]["status"], "pending")   # 下游一起重跑
        self.assertEqual(tm2["c"]["status"], "carried")   # 不相关成功分支保留
        self.assertEqual(tm2["c"]["source_run_id"], run_id)

    def test_rerun_failed_node_keeps_unrelated_success(self):
        state = os.path.join(self.tmp, "rerun.state")
        flaky = ("import sys, os\n"
                 "sys.exit(0 if os.path.exists(%r) else 1)\n") % state
        flow = validate_flow(flow_dict([
            task("bad", flaky),
            task("down", "print('d')", deps=["bad"]),
            task("side", "print('s')"),
        ]))
        self.make_scheduler(flow)
        run1 = create_run(self.db, flow)
        run = self.wait_run(run1)
        self.assertEqual(run["status"], "failed")

        # 修复"环境"后重跑失败节点
        with open(state, "w") as f:
            f.write("fixed")
        run2 = create_rerun(self.db, flow, self.db.get_run(run1), ["bad"])
        run = self.wait_run(run2)
        self.assertEqual(run["status"], "success")
        tm2 = self.task_map(run2)
        self.assertEqual(tm2["bad"]["status"], "success")
        self.assertEqual(tm2["down"]["status"], "success")
        self.assertEqual(tm2["side"]["status"], "carried")
        self.assertEqual(tm2["side"]["source_run_id"], run1)
        # 继承的任务在新运行里没有尝试记录, 结果不会混进新执行
        self.assertEqual(self.db.count_attempts(tm2["side"]["id"]), 0)
        # 重跑配置有记录
        r2 = self.db.get_run(run2)
        self.assertEqual(r2["kind"], "rerun")
        self.assertEqual(r2["source_run_id"], run1)
        self.assertFalse(r2["config_mixed"])

    def test_rerun_with_changed_config_is_flagged(self):
        flow = validate_flow(flow_dict([task("a", "import sys; sys.exit(1)")]))
        self.make_scheduler(flow)
        run1 = create_run(self.db, flow)
        self.wait_run(run1)
        # 配置变更后重跑: 必须标记 config_mixed, 不与旧配置结果混为一次成功运行
        flow2 = validate_flow(flow_dict([task("a", "print('fixed')")]))
        run2 = create_rerun(self.db, flow2, self.db.get_run(run1), ["a"])
        r2 = self.db.get_run(run2)
        self.assertTrue(r2["config_mixed"])
        self.assertNotEqual(r2["config_hash"], self.db.get_run(run1)["config_hash"])
        self.wait_run(run2)
        self.assertEqual(self.db.get_run(run2)["status"], "success")

    def test_multiple_runs_isolated(self):
        flow = validate_flow(flow_dict([task("a", "print('hi')")]))
        self.make_scheduler(flow)
        r1 = create_run(self.db, flow)
        r2 = create_run(self.db, flow)
        self.wait_run(r1)
        self.wait_run(r2)
        self.assertEqual(self.db.get_run(r1)["status"], "success")
        self.assertEqual(self.db.get_run(r2)["status"], "success")
        t1 = self.task_map(r1)["a"]
        t2 = self.task_map(r2)["a"]
        d1 = os.path.dirname(self.db.get_attempts(t1["id"])[0]["log_path"])
        d2 = os.path.dirname(self.db.get_attempts(t2["id"])[0]["log_path"])
        self.assertNotEqual(d1, d2)  # 各自独立的日志/产物目录


if __name__ == "__main__":
    unittest.main()
