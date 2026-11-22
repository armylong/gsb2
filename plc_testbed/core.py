"""核心模拟引擎:切包、扰动(乱序/掉包)、抖动缓冲、PLC 补偿。

全部确定性:同一素材 + 同一参数 => 逐比特相同的输出。
不依赖 Qt,可单独被测试/脚本使用。
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
import numpy as np

SAMPLE_RATE = 16000


# ---------------------------------------------------------------- 素材合成

def synth_speech_like(duration_s: float = 3.0, sr: int = SAMPLE_RATE, seed: int = 0) -> np.ndarray:
    """确定性的类语音素材:谐波音节串 + 振动 + 停顿。"""
    rng = np.random.RandomState(seed)
    n = int(duration_s * sr)
    out = np.zeros(n)
    pos = 0.0
    while pos < duration_s - 0.2:
        seg_len = rng.uniform(0.18, 0.45)
        pause = rng.uniform(0.05, 0.15)
        f0 = rng.uniform(110, 220)
        i0, i1 = int(pos * sr), min(n, int((pos + seg_len) * sr))
        if i1 <= i0:
            break
        tt = np.arange(i1 - i0) / sr
        vib = 1.0 + 0.02 * np.sin(2 * np.pi * 5.0 * tt)
        phase = 2 * np.pi * f0 * np.cumsum(vib) / sr
        sig = (0.6 * np.sin(phase)
               + 0.3 * np.sin(2 * phase + 0.4)
               + 0.15 * np.sin(3 * phase + 1.1))
        env = np.sin(np.pi * np.linspace(0, 1, i1 - i0)) ** 0.7
        out[i0:i1] += sig * env * 0.5
        pos += seg_len + pause
    out += 0.01 * rng.randn(n) * (np.abs(out) > 1e-4)
    return np.clip(out, -1, 1)


def synth_chirp(duration_s: float = 3.0, sr: int = SAMPLE_RATE) -> np.ndarray:
    """扫频 + 幅度调制素材(对相位连续性敏感,容易听出补得好不好)。"""
    n = int(duration_s * sr)
    t = np.arange(n) / sr
    f = np.linspace(200, 2000, n)
    phase = 2 * np.pi * np.cumsum(f) / sr
    am = 0.5 * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t))
    return np.clip(am * np.sin(phase), -1, 1)


# ---------------------------------------------------------------- 扰动样例

PRESETS = ["clean", "jitter_mild", "reorder_pairs", "loss_random",
           "loss_burst", "mixed", "custom"]

PRESET_LABELS = {
    "clean": "clean(无扰动)",
    "jitter_mild": "jitter_mild(轻度抖动)",
    "reorder_pairs": "reorder_pairs(成对乱序)",
    "loss_random": "loss_random(随机丢包10%)",
    "loss_burst": "loss_burst(突发丢包)",
    "mixed": "mixed(抖动+丢包+长突发)",
    "custom": "custom(自定义丢包率/抖动)",
}


def simulate_network(n_packets: int, packet_ms: float, preset: str, seed: int,
                     loss_rate: float = 0.1, jitter_max_ms: float = 30.0):
    """返回 (lost[n] bool, delay_ms[n] float)。确定性(由 seed 决定)。"""
    rng = np.random.RandomState(seed)
    lost = np.zeros(n_packets, dtype=bool)
    delay = np.zeros(n_packets)

    if preset in ("jitter_mild", "loss_random", "mixed", "custom"):
        jmax = {"jitter_mild": 0.8 * packet_ms,
                "loss_random": 0.5 * packet_ms,
                "mixed": 1.0 * packet_ms}.get(preset, jitter_max_ms)
        delay += rng.uniform(0.0, jmax, n_packets)
    if preset == "reorder_pairs":
        delay[0::2] += 1.5 * packet_ms  # 偶数包晚到 => 与后一个包互换到达顺序
    if preset in ("loss_random", "mixed", "custom"):
        p = loss_rate if preset == "custom" else (0.10 if preset == "loss_random" else 0.08)
        lost |= rng.rand(n_packets) < p
    if preset in ("loss_burst", "mixed"):
        # 固定位置的突发:一次 3 包短突发 + 一次 8 包长突发(演示平滑衰减)
        s1 = max(2, n_packets // 3)
        lost[s1:s1 + 3] = True
        s2 = max(s1 + 5, (2 * n_packets) // 3)
        lost[s2:s2 + 8] = True
    return lost, delay


# ---------------------------------------------------------------- 参数与结果

@dataclass
class EngineParams:
    packet_ms: float = 20.0
    playout_delay_ms: float = 100.0   # 接收侧等多久才放(抖动缓冲)
    plc_mode: str = "extrapolate"     # "silence" | "extrapolate"
    preset: str = "mixed"
    seed: int = 1
    loss_rate: float = 0.10           # custom 用
    jitter_max_ms: float = 30.0       # custom 用
    fade_start_ms: float = 80.0       # 连续缺失超过此时长开始平滑衰减
    fade_len_ms: float = 60.0         # 衰减到 0 的时长
    xfade_ms: float = 10.0            # 恢复时与真实内容的交叉淡化时长


@dataclass
class PacketRec:
    index: int
    send_ms: float          # 本来该播的时刻(= 采集/发送时刻)
    arrival_ms: float       # 模拟送到接收侧的时刻(丢包为 nan)
    sched_play_ms: float    # 接收侧安排的播放时刻
    status: str             # played / late / lost
    slot_samples: int       # 该包在输出中占的样本数(流尾包可能不足)
    concealed: bool         # 该时隙是否由 PLC 填补
    gap_id: int             # 所属缺口编号,不在缺口中为 -1


@dataclass
class SimResult:
    output: np.ndarray
    packets: list           # list[PacketRec]
    gaps: list              # list[dict]
    stats: dict
    params: EngineParams
    sr: int


# ---------------------------------------------------------------- PLC 渲染器

def _estimate_pitch(hist: np.ndarray, sr: int):
    """自相关估计基音周期(样本数)。信号太弱/太短返回 None。"""
    if len(hist) < 320:
        return None
    w = hist[-640:] if len(hist) >= 640 else hist
    w = w - w.mean()
    ac = np.correlate(w, w, "full")[len(w) - 1:]
    if ac[0] <= 1e-9:
        return None
    lo, hi = int(sr * 0.002), min(int(sr * 0.02), len(ac) - 1)  # 50..500 Hz
    if hi <= lo:
        return None
    lag = lo + int(np.argmax(ac[lo:hi]))
    if ac[lag] < 0.3 * ac[0]:
        return None
    return lag


class PlcRenderer:
    """按播放顺序逐个时隙渲染输出;长度永远与载荷长度一致(含流尾短包)。"""

    def __init__(self, sr: int, params: EngineParams):
        self.sr = sr
        self.p = params
        self.buf = np.zeros(0)          # 已渲染的全部输出
        self.period = int(0.01 * sr)    # 基音周期估计,默认 10ms
        self.consec_concealed = 0       # 当前缺口已连续填补的样本数
        self.gap_active = False

    # -- 内部 ------------------------------------------------------------
    def _refresh_pitch(self):
        lag = _estimate_pitch(self.buf, self.sr)
        if lag:
            self.period = lag

    def _conceal_block(self, n: int, time_offset: int) -> np.ndarray:
        """从已输出内容做相位连续的外推,time_offset 为起始的连续缺失样本数。

        不改变自身状态,可同时用于缺口填补和恢复时的交叉淡化延续。
        """
        p = self.p
        t_ms = (time_offset + np.arange(n)) / self.sr * 1000.0
        gain = 0.98 ** (t_ms / 10.0)
        over = t_ms > p.fade_start_ms
        if np.any(over):
            x = np.clip((t_ms[over] - p.fade_start_ms) / p.fade_len_ms, 0.0, 1.0)
            gain[over] *= 0.5 * (1.0 + np.cos(np.pi * x))
        if len(self.buf) < self.period or p.plc_mode == "silence":
            return np.zeros(n)
        base = len(self.buf)
        cat = np.concatenate([self.buf, np.zeros(n)])
        for j in range(n):
            cat[base + j] = cat[base + j - self.period]
        return cat[base:] * gain

    # -- 对外 ------------------------------------------------------------
    def emit_concealed(self, n: int):
        if not self.gap_active:
            self.gap_active = True
            self.consec_concealed = 0
            self._refresh_pitch()
        seg = self._conceal_block(n, self.consec_concealed)
        self.buf = np.concatenate([self.buf, seg])
        self.consec_concealed += n

    def emit_real(self, payload: np.ndarray) -> int:
        """返回恢复点(真实内容在输出中的起始样本号);非恢复场景返回 -1。"""
        recovery_pos = -1
        seg = payload.astype(float).copy()
        if self.gap_active and self.p.plc_mode == "extrapolate" and len(seg) > 0:
            # 与 PLC 延续做交叉淡化,避免接缝爆音;总长度不变
            x = min(int(self.p.xfade_ms * self.sr / 1000), len(seg))
            if x > 0:
                cont = self._conceal_block(x, self.consec_concealed)
                w = 0.5 * (1.0 - np.cos(np.pi * np.arange(x) / x))
                seg[:x] = (1.0 - w) * cont + w * seg[:x]
            recovery_pos = len(self.buf)
        self.buf = np.concatenate([self.buf, seg])
        self.gap_active = False
        self.consec_concealed = 0
        return recovery_pos


# ---------------------------------------------------------------- 主流程

def run_simulation(samples: np.ndarray, sr: int, params: EngineParams) -> SimResult:
    samples = np.asarray(samples, dtype=float)
    packet_samples = max(1, int(round(params.packet_ms * sr / 1000.0)))
    payloads = [samples[i:i + packet_samples]
                for i in range(0, len(samples), packet_samples)]
    if not payloads:
        payloads = [np.zeros(0)]
    n = len(payloads)

    lost, delay = simulate_network(n, params.packet_ms, params.preset, params.seed,
                                   params.loss_rate, params.jitter_max_ms)
    send_ms = np.arange(n) * params.packet_ms
    arrival_ms = send_ms + delay
    sched_play_ms = params.playout_delay_ms + send_ms

    renderer = PlcRenderer(sr, params)
    packets: list[PacketRec] = []
    gaps: list[dict] = []
    gap_id = -1
    gap_start_sample = 0
    gap_slots = 0
    prev_concealed = False

    for i in range(n):
        if lost[i]:
            status = "lost"
        elif arrival_ms[i] > sched_play_ms[i] + 1e-9:
            status = "late"      # 过了播放时刻才到:丢弃,绝不插回后面的声音里
        else:
            status = "played"

        concealed = status != "played"
        if concealed:
            if not prev_concealed:
                gap_id += 1
                gap_start_sample = len(renderer.buf)
                gap_slots = 0
            renderer.emit_concealed(len(payloads[i]))
            gap_slots += 1
            gid = gap_id
        else:
            recovery_sample = len(renderer.buf)  # 真实内容恢复位置(追加前)
            renderer.emit_real(payloads[i])
            if prev_concealed:
                gaps.append({
                    "gap_id": gap_id,
                    "start_ms": gap_start_sample / sr * 1000.0,
                    "end_ms": recovery_sample / sr * 1000.0,  # 缺口结束=恢复点
                    "n_slots": gap_slots,
                    "recovery_sample": recovery_sample,
                    "recovery_ms": recovery_sample / sr * 1000.0,
                })
            gid = -1
        prev_concealed = concealed

        packets.append(PacketRec(
            index=i,
            send_ms=float(send_ms[i]),
            arrival_ms=float(arrival_ms[i]) if not lost[i] else float("nan"),
            sched_play_ms=float(sched_play_ms[i]),
            status=status,
            slot_samples=len(payloads[i]),
            concealed=concealed,
            gap_id=gid,
        ))

    # 流尾以缺口结束:缺口没有恢复点,也要记录
    if packets and packets[-1].concealed:
        gaps.append({
            "gap_id": gap_id,
            "start_ms": gap_start_sample / sr * 1000.0,
            "end_ms": len(renderer.buf) / sr * 1000.0,
            "n_slots": gap_slots,
            "recovery_sample": -1,
            "recovery_ms": -1.0,
        })

    output = renderer.buf
    assert len(output) == len(samples), "输出长度必须与输入一致(每个时隙长度恒定)"

    n_played = sum(1 for p in packets if p.status == "played")
    n_late = sum(1 for p in packets if p.status == "late")
    n_lost = sum(1 for p in packets if p.status == "lost")
    concealed_samples = sum(p.slot_samples for p in packets if p.concealed)
    longest_gap_ms = max((g["end_ms"] - g["start_ms"] for g in gaps), default=0.0)

    stats = {
        "n_packets": n,
        "n_played": n_played,
        "n_late": n_late,
        "n_lost": n_lost,
        "n_gaps": len(gaps),
        "concealed_slots": n_late + n_lost,
        "concealed_samples": concealed_samples,
        "concealed_ms": concealed_samples / sr * 1000.0,
        "longest_gap_ms": longest_gap_ms,
        "playout_delay_ms": params.playout_delay_ms,
        "added_wait_ms": params.playout_delay_ms,   # 相对零缓冲多等的时间
        "stream_ms": len(output) / sr * 1000.0,
        "tail_packet_samples": len(payloads[-1]),
        "packet_samples": packet_samples,
    }
    return SimResult(output=output, packets=packets, gaps=gaps,
                     stats=stats, params=params, sr=sr)


def params_to_dict(p: EngineParams) -> dict:
    return asdict(p)
