"""MIDI 事件模型:读取音符开关、力度、延音踏板、速度变化,统一换算 tick/拍/秒。

规则约定(界面里也会写明):
- 同一 tick 上有多条事件时,按 (tick, 轨道号, 轨内先后) 排序,顺序稳定、可解释;
  表格里的 "顺序#" 就是最终处理顺序。
- 踏板 CC64:值 >= 64 为踩下,< 64 为抬起。
- 键已松但踏板踩着 -> 音符进入 "延音保持",踏板抬起那一刻才开始释音。
- 同一音在旧音还在响(按住或延音中)时再次按下 -> 旧音立即做 8ms 短淡出,新音重新起音。
"""
from __future__ import annotations

from dataclasses import dataclass, field

PPQ_DEFAULT = 480
PEDAL_ON = 64
RELEASE_SEC = 0.25   # 释音(消音)包络长度
FADEOUT_SEC = 0.008  # 同音重复时旧音的短淡出


@dataclass
class Event:
    tick: int
    order: int          # 同 tick 的稳定顺序号
    kind: str           # 'note_on' | 'note_off' | 'pedal' | 'tempo'
    pitch: int = 0
    velocity: int = 0
    value: int = 0      # pedal: 0-127;tempo: 微秒/四分音符
    track: int = 0
    seconds: float = 0.0
    beat: float = 0.0

    def describe(self) -> str:
        if self.kind == "note_on":
            return f"音名 {pitch_name(self.pitch)}({self.pitch}) 力度 {self.velocity}"
        if self.kind == "note_off":
            return f"音名 {pitch_name(self.pitch)}({self.pitch}) 松键"
        if self.kind == "pedal":
            return f"延音踏板 {'踩下' if self.value >= PEDAL_ON else '抬起'} (CC64={self.value})"
        if self.kind == "tempo":
            return f"速度 {6e7 / self.value:.1f} BPM ({self.value} us/四分)"
        return self.kind


def pitch_name(p: int) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{names[p % 12]}{p // 12 - 1}"


class TempoMap:
    """tick <-> 秒 的双向换算,支持任意多次速度变化。"""

    def __init__(self, tempo_points, ppq: int):
        # tempo_points: [(tick, us_per_quarter)],按 tick 升序
        self.ppq = ppq
        self.points = []  # (tick, seconds, us_per_quarter)
        sec = 0.0
        last_tick = 0
        tempo = 500000
        self.points.append((0, 0.0, tempo))
        for tick, us in sorted(tempo_points):
            if tick <= 0:
                # tick 0 的初始速度
                self.points[0] = (0, 0.0, us)
                tempo = us
                continue
            sec += (tick - last_tick) * tempo / 1e6 / ppq
            last_tick = tick
            tempo = us
            self.points.append((tick, sec, tempo))

    def seconds_at(self, tick: int) -> float:
        pts = self.points
        i = 0
        for j in range(len(pts)):
            if pts[j][0] <= tick:
                i = j
            else:
                break
        t0, s0, tempo = pts[i]
        return s0 + (tick - t0) * tempo / 1e6 / self.ppq

    def tick_at(self, seconds: float) -> int:
        pts = self.points
        i = 0
        for j in range(len(pts)):
            if pts[j][1] <= seconds:
                i = j
            else:
                break
        t0, s0, tempo = pts[i]
        return int(round(t0 + (seconds - s0) * 1e6 * self.ppq / tempo))

    def beat_at(self, tick: int) -> float:
        return tick / self.ppq


def load_midi(path) -> tuple[list[Event], int, TempoMap]:
    """读取 SMF,返回 (事件列表, ppq, 速度映射)。事件已按稳定顺序排好并填好秒/拍。"""
    import mido

    mid = mido.MidiFile(path)
    ppq = mid.ticks_per_beat or PPQ_DEFAULT
    raw = []  # (tick, track_idx, idx_in_track, kind, pitch, vel, value)
    for ti, track in enumerate(mid.tracks):
        abs_tick = 0
        for ii, msg in enumerate(track):
            abs_tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                raw.append((abs_tick, ti, ii, "note_on", msg.note, msg.velocity, 0))
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                raw.append((abs_tick, ti, ii, "note_off", msg.note, 0, 0))
            elif msg.type == "control_change" and msg.control == 64:
                raw.append((abs_tick, ti, ii, "pedal", 0, 0, msg.value))
            elif msg.type == "set_tempo":
                raw.append((abs_tick, ti, ii, "tempo", 0, 0, msg.tempo))
    # 稳定顺序:tick -> 轨道号 -> 轨内先后
    raw.sort(key=lambda r: (r[0], r[1], r[2]))

    tempo_points = [(r[0], r[6]) for r in raw if r[3] == "tempo"]
    tmap = TempoMap(tempo_points, ppq)

    events = []
    for order, r in enumerate(raw):
        ev = Event(tick=r[0], order=order, kind=r[3], pitch=r[4],
                   velocity=r[5], value=r[6], track=r[1])
        ev.seconds = tmap.seconds_at(ev.tick)
        ev.beat = tmap.beat_at(ev.tick)
        events.append(ev)
    return events, ppq, tmap


def refresh_times(events: list[Event], tmap: TempoMap) -> list[Event]:
    """编辑(改了 tick)之后重排并重新换算秒/拍。同 tick 保持原顺序号 -> 稳定。"""
    events.sort(key=lambda e: (e.tick, e.order))
    for i, ev in enumerate(events):
        ev.order = i
        ev.seconds = tmap.seconds_at(ev.tick)
        ev.beat = tmap.beat_at(ev.tick)
    return events


@dataclass
class Voice:
    """一次发声的完整时间线:按下 -> 松键 -> (踏板保持) -> 开始释音 -> 实际消音。"""
    pitch: int
    velocity: int
    start: float          # 按下(秒)
    keyup: float | None   # 松键(秒)
    sustained: bool       # 松键时踏板踩着,被踏板保留
    release: float        # 开始释音(秒):松键时刻 或 踏板抬起时刻
    stop: float           # 实际消音(秒,含释音尾巴)
    cut: bool             # 被同音再次按下截断(短淡出)
    on_tick: int = 0
    keyup_tick: int | None = None

    def name(self):
        return pitch_name(self.pitch)


def schedule(events: list[Event]) -> list[Voice]:
    """把事件流翻译成发声计划。GUI 表格和音频渲染共用这一份,保证一致。"""
    pedal = False
    active: dict[int, Voice] = {}   # 还在响的(按住中 或 延音保持中)
    done: list[Voice] = []

    for ev in events:
        t = ev.seconds
        if ev.kind == "note_on":
            old = active.pop(ev.pitch, None)
            if old is not None:
                # 同音重复:旧音短淡出截断
                old.release = t
                old.stop = t + FADEOUT_SEC
                old.cut = True
                done.append(old)
            active[ev.pitch] = Voice(ev.pitch, ev.velocity, start=t, keyup=None,
                                     sustained=False, release=t, stop=t,
                                     cut=False, on_tick=ev.tick)
        elif ev.kind == "note_off":
            v = active.get(ev.pitch)
            if v is None or v.keyup is not None:
                continue
            v.keyup = t
            v.keyup_tick = ev.tick
            if pedal:
                v.sustained = True          # 被踏板保留,继续响
            else:
                v.release = t
                v.stop = t + RELEASE_SEC
                done.append(v)
                del active[ev.pitch]
        elif ev.kind == "pedal":
            down = ev.value >= PEDAL_ON
            if pedal and not down:
                # 踏板抬起:所有 "已松键但被保留" 的音此刻开始释音
                for p, v in list(active.items()):
                    if v.keyup is not None:
                        v.release = t
                        v.stop = t + RELEASE_SEC
                        done.append(v)
                        del active[p]
            pedal = down

    end = events[-1].seconds if events else 0.0
    for p, v in active.items():  # 曲末仍在响的
        r = v.keyup if v.keyup is not None else end
        v.release = r
        v.stop = r + RELEASE_SEC
        done.append(v)
    done.sort(key=lambda v: (v.start, v.pitch))
    return done


def state_at(events: list[Event], tick: int):
    """重放到某个 tick,返回 (踏板是否踩着, 按住中的音, 延音保持中的音)。
    用于:跳到中间位置时确认该恢复哪些延音音符。"""
    pedal = False
    held: dict[int, float] = {}
    sustained: dict[int, float] = {}
    for ev in events:
        if ev.tick > tick:
            break
        if ev.kind == "note_on":
            sustained.pop(ev.pitch, None)
            held[ev.pitch] = ev.seconds
        elif ev.kind == "note_off":
            if ev.pitch in held:
                held.pop(ev.pitch)
                if pedal:
                    sustained[ev.pitch] = ev.seconds
            elif ev.pitch in sustained and not pedal:
                sustained.pop(ev.pitch, None)
        elif ev.kind == "pedal":
            down = ev.value >= PEDAL_ON
            if pedal and not down:
                sustained.clear()
            pedal = down
    return pedal, sorted(held), sorted(sustained)
