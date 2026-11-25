/**
 * App —— 短包络编辑器主界面。
 *
 * 声音过程只有一份（VoiceEngine）：离线渲染出的 PCM 同时驱动
 * 振幅曲线、序列试听和 WAV 导出；实时试听在 AudioWorklet 里跑同一个类。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EnvelopeEditor } from './components/EnvelopeEditor';
import { AmplitudeChart } from './components/AmplitudeChart';
import { EventTable } from './components/EventTable';
import { WavVerifyPanel } from './components/WavVerifyPanel';
import { renderSequence } from './audio/OfflineRenderer';
import type { RenderResult } from './audio/OfflineRenderer';
import { PcmPlayer, RealtimeVoice } from './audio/RealtimeVoice';
import { encodeWav } from './audio/wav';
import { PRESETS } from './audio/presets';
import { clampTimbre, DEFAULT_TIMBRE } from './audio/types';
import type { TimbreParams, Waveform } from './audio/types';
import type { KeySequence, SequenceEvent } from './audio/sequence';
import { lastEventTime, nextEventId, sortedEvents } from './audio/sequence';

const RENDER_SR = 48000;
type UpdateMode = 'pending' | 'live';

const INITIAL_SEQUENCE: KeySequence = {
  name: '断音（提前松开）',
  events: [
    { id: nextEventId(), time: 0.2, type: 'noteOn', velocity: 0.9 },
    { id: nextEventId(), time: 0.42, type: 'noteOff' },
  ],
};

export default function App() {
  const [timbre, setTimbre] = useState<TimbreParams>(() =>
    clampTimbre(structuredClone(DEFAULT_TIMBRE)),
  );
  const [sequence, setSequence] = useState<KeySequence>(INITIAL_SEQUENCE);
  const [updateMode, setUpdateMode] = useState<UpdateMode>('pending');
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () =>
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') as 'light' | 'dark',
  );
  const [insertTime, setInsertTime] = useState(0.2);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [liveAmp, setLiveAmp] = useState<number | null>(null);
  const [wavBuffer, setWavBuffer] = useState<ArrayBuffer | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const voiceRef = useRef<RealtimeVoice | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  /** 当前播放器持有的渲染对象；与最新 render 引用不同即说明 PCM 过期需重建 */
  const playerRenderRef = useRef<RenderResult | null>(null);
  const rafRef = useRef<number>(0);
  /** 停止状态下点击曲线记录的跳转点，下次回放从这里开始 */
  const seekRef = useRef(0);

  // ---- 唯一的离线渲染：曲线 / 试听 / WAV 同源 ----
  const render = useMemo(
    () => renderSequence(sequence, timbre, RENDER_SR),
    [sequence, timbre],
  );

  // 只读调试钩子：供端到端测试断言渲染结果，不参与交互
  useEffect(() => {
    (window as unknown as { __envelopeDebug?: unknown }).__envelopeDebug = {
      render,
      liveAmp,
      ctxState: ctxRef.current?.state ?? null,
    };
  }, [render, liveAmp]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const ensureAudio = useCallback(async () => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
      voiceRef.current = new RealtimeVoice();
      // worklet 只在振幅变化时上报；回到 0 即撤下指示点
      voiceRef.current.onAmp((a) => setLiveAmp(a > 0 ? a : null));
    }
    await voiceRef.current!.ensure(ctxRef.current);
    return ctxRef.current;
  }, []);

  // ---- 参数编辑：按模式决定实时声音如何响应 ----
  const editTimbre = useCallback(
    (next: TimbreParams) => {
      const clamped = clampTimbre(next);
      setTimbre(clamped);
      // worklet 尚未创建时静默；引擎内部按模式选择挂起或从当前电平过渡
      voiceRef.current?.setParams(clamped, updateMode);
    },
    [updateMode],
  );

  const editEnvelope = useCallback(
    (envelope: TimbreParams['envelope']) => editTimbre({ ...timbre, envelope }),
    [editTimbre, timbre],
  );

  // ---- 播放头动画 ----
  const tickPlayhead = useCallback(() => {
    const p = playerRef.current;
    if (p?.isPlaying) {
      setPlayhead(p.position);
      rafRef.current = requestAnimationFrame(tickPlayhead);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    playerRef.current?.stop();
    playerRef.current = null;
    playerRenderRef.current = null;
    cancelAnimationFrame(rafRef.current);
    seekRef.current = 0;
    setIsPlaying(false);
    setPlayhead(0);
  }, []);

  const playSequence = useCallback(async () => {
    const ctx = await ensureAudio();
    // 暂停后再点回放：PCM 未过期则保留暂停偏移继续；过期（改过参数/序列）则重建。
    // 用 render 对象引用判定——useMemo 保证依赖不变时引用稳定，不受播放头重渲染影响。
    const existing = playerRef.current;
    if (existing && playerRenderRef.current === render) {
      await existing.play();
      setIsPlaying(true);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tickPlayhead);
      return;
    }
    existing?.stop();
    cancelAnimationFrame(rafRef.current);
    const player = new PcmPlayer(ctx, render.pcm, render.sampleRate, () => {
      cancelAnimationFrame(rafRef.current);
      playerRef.current = null;
      playerRenderRef.current = null;
      seekRef.current = 0;
      setIsPlaying(false);
      setPlayhead(0);
    });
    playerRenderRef.current = render;
    // 从停止状态下点击曲线设定的跳转点开始（默认 0）
    if (seekRef.current > 0) {
      player.seek(seekRef.current);
    }
    playerRef.current = player;
    await player.play();
    setIsPlaying(true);
    rafRef.current = requestAnimationFrame(tickPlayhead);
  }, [ensureAudio, render, tickPlayhead]);

  const pausePlayback = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    p.pause();
    cancelAnimationFrame(rafRef.current);
    setIsPlaying(false);
    setPlayhead(p.position); // 暂停点保留，恢复时触发点位置不变
  }, []);

  const seek = useCallback(
    (t: number) => {
      setInsertTime(Number(t.toFixed(3)));
      const p = playerRef.current;
      if (p) {
        // 播放中或暂停中：直接移动播放器位置，事件相对关系逐采样不变
        p.seek(t);
        setPlayhead(t);
      } else {
        // 停止状态：记录跳转点，下一次回放从这里开始
        seekRef.current = t;
        setPlayhead(t);
      }
    },
    [],
  );

  // ---- 手动按键（实时 worklet）----
  const pressKey = useCallback(
    async (velocity = 1) => {
      await ensureAudio();
      stopPlayback();
      voiceRef.current!.setParams(timbre, updateMode);
      voiceRef.current!.noteOn(velocity);
      // 指示点由 worklet 的振幅上报驱动，无需本地预置
    },
    [ensureAudio, stopPlayback, timbre, updateMode],
  );

  const releaseKey = useCallback(() => {
    voiceRef.current?.noteOff();
  }, []);

  // 空格按住发声、松开释放
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
        return;
      e.preventDefault();
      void pressKey(1);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      releaseKey();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [pressKey, releaseKey]);

  // ---- 预设 ----
  const loadPreset = useCallback((presetIndex: number) => {
    const preset = PRESETS[presetIndex];
    if (!preset) return;
    stopPlayback();
    setTimbre(clampTimbre(structuredClone(preset.timbre)));
    setSequence(structuredClone(preset.sequence));
    setInsertTime(Math.min(0.2, lastEventTime(preset.sequence)));
  }, [stopPlayback]);

  // ---- 在当前时刻插入 paramChange，快照当前参数与模式 ----
  const insertParamChange = useCallback(() => {
    const ev: SequenceEvent = {
      id: nextEventId(),
      time: Number(insertTime.toFixed(3)),
      type: 'paramChange',
      params: structuredClone(timbre),
      mode: updateMode,
    };
    setSequence((s) => ({ ...s, events: [...s.events, ev] }));
  }, [insertTime, timbre, updateMode]);

  // ---- WAV 导出 ----
  const exportWav = useCallback(() => {
    const buf = encodeWav(render.pcm, render.sampleRate);
    setWavBuffer(buf);
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sequence.name || 'sequence'}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }, [render, sequence.name]);

  const sorted = sortedEvents(sequence.events);
  const segFields: {
    key: keyof Pick<TimbreParams['envelope'], 'attack' | 'decay' | 'sustain' | 'release'>;
    label: string;
    unit: string;
    max: number;
    step: number;
  }[] = [
    { key: 'attack', label: '起音 A', unit: 's', max: 2, step: 0.005 },
    { key: 'decay', label: '衰减 D', unit: 's', max: 2, step: 0.005 },
    { key: 'sustain', label: '保持 S', unit: '', max: 1, step: 0.01 },
    { key: 'release', label: '释放 R', unit: 's', max: 2, step: 0.005 },
  ];
  const shapeFields: {
    key: 'attackShape' | 'decayShape' | 'releaseShape';
    label: string;
  }[] = [
    { key: 'attackShape', label: '起音形状' },
    { key: 'decayShape', label: '衰减形状' },
    { key: 'releaseShape', label: '释放形状' },
  ];

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>ADSR 短包络编辑器 · 断音与再触发检查</h1>
          <div className="sub">
            曲线、试听与 WAV 出自同一个逐采样声音过程（VoiceEngine）
          </div>
        </div>
        <button className="tiny theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '切浅色' : '切深色'}
        </button>
      </header>

      <div className="grid">
        {/* 左列：音色与包络 */}
        <div className="stack">
          <section className="card">
            <h2>音色（一种）</h2>
            <div className="row spread">
              <label className="hint">波形</label>
              <select
                value={timbre.waveform}
                onChange={(e) => editTimbre({ ...timbre, waveform: e.target.value as Waveform })}
              >
                <option value="sine">正弦 sine</option>
                <option value="triangle">三角 triangle</option>
                <option value="sawtooth">锯齿 sawtooth</option>
                <option value="square">方波 square</option>
              </select>
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label>基频 Hz</label>
              <input
                type="range"
                min={55}
                max={1200}
                step={1}
                value={timbre.frequency}
                onChange={(e) => editTimbre({ ...timbre, frequency: Number(e.target.value) })}
              />
              <span className="val">{timbre.frequency}</span>
            </div>
            <div className="field">
              <label>主增益</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={timbre.masterGain}
                onChange={(e) => editTimbre({ ...timbre, masterGain: Number(e.target.value) })}
              />
              <span className="val">{timbre.masterGain.toFixed(2)}</span>
            </div>
          </section>

          <section className="card">
            <h2>包络</h2>
            <EnvelopeEditor envelope={timbre.envelope} onChange={editEnvelope} />
            <h3>段参数</h3>
            {segFields.map((f) => (
              <div className="field" key={f.key}>
                <label>{f.label}</label>
                <input
                  type="range"
                  min={0}
                  max={f.max}
                  step={f.step}
                  value={timbre.envelope[f.key]}
                  onChange={(e) =>
                    editEnvelope({ ...timbre.envelope, [f.key]: Number(e.target.value) })
                  }
                />
                <span className="val">
                  {timbre.envelope[f.key].toFixed(3)}
                  {f.unit}
                </span>
              </div>
            ))}
            <h3>曲线形状（-1 凹 / 0 线性 / +1 凸）</h3>
            {shapeFields.map((f) => (
              <div className="field" key={f.key}>
                <label>{f.label}</label>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={timbre.envelope[f.key]}
                  onChange={(e) =>
                    editEnvelope({ ...timbre.envelope, [f.key]: Number(e.target.value) })
                  }
                />
                <span className="val">{timbre.envelope[f.key].toFixed(2)}</span>
              </div>
            ))}
          </section>

          <section className="card">
            <h2>改包络时如何影响声音</h2>
            <div className="segmented" role="group" aria-label="参数生效模式">
              <button
                className={updateMode === 'pending' ? 'active' : ''}
                onClick={() => setUpdateMode('pending')}
              >
                只影响下一次
              </button>
              <button
                className={updateMode === 'live' ? 'active' : ''}
                onClick={() => setUpdateMode('live')}
              >
                当前声音过渡
              </button>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              {updateMode === 'pending'
                ? '参数挂起，正在响的声音保持旧包络，下一次按下才采用。'
                : '以当前电平为锚点重建当前段，平滑过渡到新包络，无瞬时跳变。'}
            </p>
            <div style={{ marginTop: 10 }}>
              <button className="tiny" onClick={insertParamChange}>
                在 {insertTime.toFixed(3)}s 插入「改参数」事件（快照当前设置）
              </button>
            </div>
          </section>

          <section className="card">
            <h2>内置检查示例</h2>
            <div className="preset-list">
              {PRESETS.map((p, i) => (
                <button key={p.id} onClick={() => loadPreset(i)}>
                  <span className="p-name">{p.sequence.name}</span>
                  <span className="p-desc">{p.description}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* 右列：序列、曲线、试听、导出 */}
        <div className="stack">
          <section className="card">
            <h2>实际振幅曲线（与试听、WAV 同一次渲染）</h2>
            <AmplitudeChart render={render} playhead={playhead} onSeek={seek} liveAmp={liveAmp} />
            <div className="legend">
              <span className="key">
                <span className="swath" style={{ background: 'var(--blue)' }} /> 振幅包络
              </span>
              <span className="key">
                <span className="tri up" /> 按下 noteOn
              </span>
              <span className="key">
                <span
                  style={{
                    display: 'inline-block',
                    width: 2,
                    height: 10,
                    background: 'var(--muted)',
                  }}
                />
                松开 noteOff
              </span>
              <span className="key">
                <span className="diamond" /> 改参数
              </span>
              <span className="key">
                <span
                  style={{
                    display: 'inline-block',
                    width: 2,
                    height: 12,
                    background: 'var(--red)',
                  }}
                />
                播放头
              </span>
            </div>
          </section>

          <section className="card">
            <h2>试听</h2>
            <div className="row">
              {!isPlaying ? (
                <button className="primary" onClick={playSequence}>
                  ▶ 回放序列
                </button>
              ) : (
                <button onClick={pausePlayback}>⏸ 暂停</button>
              )}
              <button onClick={stopPlayback} disabled={!isPlaying && playhead === 0}>
                ⏹ 停止
              </button>
              <button
                onPointerDown={(e) => {
                  // 合成事件或某些边缘环境下可能没有活动指针，捕获失败不应阻断发声
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* 无活动指针时忽略 */
                  }
                  void pressKey(1);
                }}
                onPointerUp={releaseKey}
                onPointerCancel={releaseKey}
                onPointerLeave={(e) => {
                  if (e.buttons === 1) releaseKey();
                }}
              >
                按住发声（或按住空格）
              </button>
              <span className="hint" data-testid="playhead">
                播放头 {playhead.toFixed(3)}s / 总长 {render.duration.toFixed(3)}s
              </span>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              暂停后再播放，各触发点的相对位置逐采样不变；点击曲线可移动播放头。
            </p>
          </section>

          <section className="card">
            <h2>按键序列（精确时刻，秒）</h2>
            <EventTable
              sequence={sequence}
              onChange={setSequence}
              insertTime={insertTime}
              onInsertAt={setInsertTime}
            />
            <p className="hint" style={{ marginBottom: 0 }}>
              共 {sorted.length} 个事件，最后事件 {lastEventTime(sequence).toFixed(3)}s；
              同时刻的按下+松开即零长度音。
            </p>
          </section>

          <section className="card">
            <h2>WAV 导出与回读对照</h2>
            <WavVerifyPanel render={render} wavBuffer={wavBuffer} onExport={exportWav} />
          </section>
        </div>
      </div>
    </div>
  );
}
