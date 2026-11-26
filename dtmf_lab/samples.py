"""预置样音: 覆盖连续重复键、缺一支音、停顿过短、短键、轻微频差、强弱悬殊和背景声.

每个场景都给出合成参数 + 逐键偏差, 以及一份"人眼看应该得到什么"的期望说明.
界面上可以一键生成并载入, 也可用 `python -m dtmf_lab.samples --out samples` 导出.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .tones import SynthSettings, ToneOverride, synthesize


@dataclass(frozen=True)
class Scenario:
    name: str
    title: str
    summary: str
    keys: str
    settings: SynthSettings
    overrides: list[ToneOverride] | None = None
    expect: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)


_CLEAN = SynthSettings()


SCENARIOS: list[Scenario] = [
    Scenario(
        name="clean_digits",
        title="干净数字串",
        summary="四个普通键, 键音 90 毫秒、间隔 70 毫秒, 没有背景声",
        keys="123A",
        settings=_CLEAN,
        expect="4 个确定按键, 起止位置与合成时的段落对齐",
        tags=("基线",),
    ),
    Scenario(
        name="hold_repeat",
        title="连续重复键 (真松开)",
        summary="同一个键按了三次, 每次之间松开 70 毫秒, 间隔足够分辨",
        keys="555",
        settings=SynthSettings(gap_ms=70),
        expect="3 个独立的 '5', 不能被合并成一次按住",
        tags=("重复键",),
    ),
    Scenario(
        name="hold_long",
        title="一直按住同一个键",
        summary="单键按住 1.2 秒不松手",
        keys="5",
        settings=SynthSettings(key_ms=1200),
        expect="只出 1 条结果, 不能随帧数重复增加",
        tags=("重复键", "按住"),
    ),
    Scenario(
        name="fast_repeat",
        title="停顿短于可分辨范围的重复键",
        summary="两次 '5' 中间只松开 25 毫秒, 低于默认 40 毫秒的可分辨下限",
        keys="55",
        settings=SynthSettings(gap_ms=25),
        expect="合并成 1 次按住并标成待核对, 备注里要写出实测绘得的空白时长",
        tags=("重复键", "短停顿"),
    ),
    Scenario(
        name="fast_pair",
        title="停顿短于可分辨范围的不同键",
        summary="'1' 和 '2' 之间只留 20 毫秒空白",
        keys="12",
        settings=SynthSettings(gap_ms=20),
        expect="两条都保留, 但降级为待核对并提示边界靠得太近",
        tags=("短停顿",),
    ),
    Scenario(
        name="missing_high",
        title="缺一支高组音",
        summary="'6' 只发低频组 770 Hz, 高组 1477 Hz 被拿掉",
        keys="6",
        settings=SynthSettings(),
        overrides=[ToneOverride(drop_high=True)],
        expect="拒绝, 原因写明只找到一组音",
        tags=("缺音",),
    ),
    Scenario(
        name="missing_low_mid",
        title="串里夹一个缺低组音的键",
        summary="'4 5 6', 中间的 '5' 缺低频组 770 Hz",
        keys="456",
        settings=SynthSettings(),
        overrides=[ToneOverride(), ToneOverride(drop_low=True), ToneOverride()],
        expect="'4' 和 '6' 通过, 中间 '5' 被拒并保留为拒绝候选",
        tags=("缺音",),
    ),
    Scenario(
        name="short_key",
        title="过短的按键",
        summary="键音 25 毫秒, 低于默认最短按键时长 40 毫秒",
        keys="258",
        settings=SynthSettings(key_ms=25),
        expect="全部被拒, 理由为按键过短, 但候选区间仍列在清单里",
        tags=("短键",),
    ),
    Scenario(
        name="short_key_mixed",
        title="短键混在正常键里",
        summary="'3' 正常, '7' 只有 30 毫秒, '9' 正常",
        keys="379",
        settings=SynthSettings(),
        overrides=[ToneOverride(), ToneOverride(key_ms=30), ToneOverride()],
        expect="'7' 被拒 (按键过短), 左右两个正常键照常给出",
        tags=("短键",),
    ),
    Scenario(
        name="slight_offset",
        title="轻微频差",
        summary="'8' 的低频组整体偏高 8 Hz, 仍在容差内但已擦边",
        keys="8",
        settings=SynthSettings(),
        overrides=[ToneOverride(low_offset_hz=8.0)],
        expect="可判为 '8', 但降级待核对, 理由给出偏差和容差",
        tags=("频差",),
    ),
    Scenario(
        name="big_offset",
        title="明显频差",
        summary="'0' 的高频组偏低 35 Hz, 超出容差",
        keys="0",
        settings=SynthSettings(),
        overrides=[ToneOverride(high_offset_hz=-35.0)],
        expect="拒绝, 理由为峰值频率偏离标称值",
        tags=("频差",),
    ),
    Scenario(
        name="twist_heavy",
        title="两支音强弱悬殊",
        summary="'9' 的高频组是低频组的十余倍, 差约 30 dB",
        keys="9",
        settings=SynthSettings(),
        overrides=[ToneOverride(low_gain=0.02)],
        expect="拒绝, 理由为强弱差超过上限",
        tags=("强弱差",),
    ),
    Scenario(
        name="twist_mid",
        title="强弱差临界",
        summary="'7' 的低频组比高频组弱约 8 dB, 但仍在 12 dB 上限内",
        keys="7",
        settings=SynthSettings(low_gain=0.18, high_gain=0.5),
        expect="可判为 '7', 但标成待核对并给出强弱差",
        tags=("强弱差",),
    ),
    Scenario(
        name="noisy_light",
        title="轻背景声",
        summary="'258' 叠了一层约 -18 dBFS 的白噪, 信噪比接近待核对线",
        keys="258",
        settings=SynthSettings(noise_level=0.35),
        expect="能认出来, 但通常标成待核对",
        tags=("背景声",),
    ),
    Scenario(
        name="noisy_heavy",
        title="重背景声",
        summary="'258' 的白噪已经和键音能量相当",
        keys="258",
        settings=SynthSettings(noise_level=1.0),
        expect="全部拒绝, 理由为纯音能量被背景声压低",
        tags=("背景声",),
    ),
    Scenario(
        name="solo_tone",
        title="单独一支音",
        summary="只有 941 Hz 一支, 没有配对的低频组音",
        keys="3",
        settings=SynthSettings(),
        overrides=[ToneOverride(drop_low=True)],
        expect="拒绝, 单独一支音不能算按键",
        tags=("缺音",),
    ),
    Scenario(
        name="mixed_showcase",
        title="综合对照",
        summary="干净键、偏频键、缺音键、短停顿重复键排在一起",
        keys="12355",
        settings=SynthSettings(gap_ms=45),
        overrides=[
            ToneOverride(),
            ToneOverride(low_offset_hz=6.0),
            ToneOverride(drop_high=True),
            ToneOverride(gap_after_ms=25),
            ToneOverride(),
        ],
        expect="前两个可判, 第三个拒绝, 最后两个同键短停顿合并成一次按住并待核对",
        tags=("综合",),
    ),
]


def scenario_by_name(name: str) -> Scenario:
    for item in SCENARIOS:
        if item.name == name:
            return item
    raise KeyError(f"没有这个样音场景: {name}")


def render_scenario(scenario: Scenario):
    return synthesize(scenario.keys, scenario.settings, scenario.overrides)


def export_all(out_dir: str | Path) -> list[Path]:
    from .wavio import save_wav

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for scenario in SCENARIOS:
        result = render_scenario(scenario)
        path = out / f"{scenario.name}.wav"
        save_wav(path, result.samples, result.sample_rate)
        written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="导出预置样音 wav")
    parser.add_argument("--out", default="samples", help="输出目录")
    parser.add_argument("--list", action="store_true", help="只列出场景")
    args = parser.parse_args(argv)
    if args.list:
        for scenario in SCENARIOS:
            print(f"{scenario.name:16s} {scenario.title:24s} {scenario.expect}")
        return 0
    paths = export_all(args.out)
    for path in paths:
        print(path)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
