"""内置样例:换速度 + 同音重复 + 长按踏板,用来核对踏板放开时机。

结构(拍,PPQ=480):
- 拍 0:速度 100 BPM;拍 4 换 60 BPM;拍 8 换 120 BPM
- 拍 0-3:C4 四分音符 x4(无踏板,干净起止)
- 拍 3.5:踏板踩下;拍 3.5/4.0/4.5/5.0:D4 短音(0.2 拍)-> 被踏板保留到拍 7
- 拍 5.5/6.0/6.5:E4 同音重复 x3(踩着踏板,触发 "旧音短淡出" 规则)
- 拍 7.0:踏板抬起(上面所有保留音此刻开始释音)
- 拍 7.0-8.5:G4 长音,拍 8 踏板又踩下 -> 松键后仍被保留到拍 11
- 拍 8.0:C4+E4+G4 和弦短音 -> 同样保留到拍 11
- 拍 11.0:踏板抬起;拍 12 结束
"""
from __future__ import annotations

import mido

PPQ = 480


def _b(beat: float) -> int:
    return int(round(beat * PPQ))


def build_sample(path: str):
    mid = mido.MidiFile(ticks_per_beat=PPQ)
    track = mido.MidiTrack()
    mid.tracks.append(track)

    events = []  # (abs_tick, msg)

    def tempo(beat, bpm):
        events.append((_b(beat), mido.MetaMessage("set_tempo",
                                                  tempo=int(round(6e7 / bpm)), time=0)))

    def note(beat, pitch, vel, dur_beats):
        events.append((_b(beat), mido.Message("note_on", note=pitch, velocity=vel, time=0)))
        events.append((_b(beat + dur_beats), mido.Message("note_off", note=pitch, velocity=0, time=0)))

    def pedal(beat, down: bool):
        events.append((_b(beat), mido.Message("control_change", control=64,
                                              value=127 if down else 0, time=0)))

    tempo(0.0, 100)
    tempo(4.0, 60)
    tempo(8.0, 120)

    for i in range(4):                       # 干净的四分音符
        note(float(i), 60, 90, 0.9)

    pedal(3.5, True)                          # 长踏板开始
    for i in range(4):                        # 短音被踏板保留
        note(3.5 + i * 0.5, 62, 80, 0.2)
    for i in range(3):                        # 同音重复(截断规则)
        note(5.5 + i * 0.5, 64, 85, 0.4)
    pedal(7.0, False)                         # 保留音集体释音

    note(7.0, 67, 88, 1.5)                    # G4 长音,松键时踏板又踩着
    pedal(8.0, True)
    for p in (60, 64, 67):                    # 和弦短音,被保留
        note(8.0, p, 75, 0.5)
    pedal(11.0, False)

    events.sort(key=lambda e: (e[0], 0 if e[1].type == "set_tempo" else 1))
    last = 0
    for tick, msg in events:
        msg.time = tick - last
        last = tick
        track.append(msg)
    track.append(mido.MetaMessage("end_of_track", time=_b(12.0) - last))
    mid.save(path)
    return path
