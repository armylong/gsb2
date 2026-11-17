import { useEffect, useRef, useState } from 'react';
import { PlayerController, Phase } from './playerController';
import { FaultPanel } from './components/FaultPanel';
import { RequestLog } from './components/RequestLog';

const MASTER_URL = '/media/sample/master.m3u8';

interface Scenario {
  key: string;
  name: string;
  desc: string;
  rules: { pattern: string; type: string; delayMs?: number }[];
  throttleKbps: number;
}

const SCENARIOS: Scenario[] = [
  {
    key: 'A',
    name: '场景A · 正常播放',
    desc: '清除全部故障，直接播放样例',
    rules: [],
    throttleKbps: 0,
  },
  {
    key: 'B',
    name: '场景B · 单段故障',
    desc: '所有清晰度的第 5 段（20–24s）持续 500，播放到此会卡住并在重试上限后报错',
    rules: [{ pattern: 'segment_005.ts', type: 'fail-always' }],
    throttleKbps: 0,
  },
  {
    key: 'C',
    name: '场景C · 慢速切换',
    desc: '720p 分片延迟 3s，整体限速 1500 kbps，便于观察慢请求期间切换清晰度',
    rules: [{ pattern: 'v2/', type: 'delay', delayMs: 3000 }],
    throttleKbps: 1500,
  },
];

const PHASE_TEXT: Record<Phase, string> = {
  idle: '未加载',
  loading: '正在加载清单…',
  ready: '就绪',
  buffering: '缓冲中…',
  retrying: '分片加载失败，正在重试…',
  failed: '已无法继续',
};

function fmt(t: number) {
  return isFinite(t) ? `${t.toFixed(1)}s` : '--';
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ctl, setCtl] = useState<PlayerController | null>(null);
  const [, setTick] = useState(0);
  const [urlInput, setUrlInput] = useState(MASTER_URL);
  const [faultsVersion, setFaultsVersion] = useState(0);
  const [scenarioMsg, setScenarioMsg] = useState('');

  useEffect(() => {
    const c = new PlayerController(videoRef.current!, () => setTick((t) => t + 1));
    setCtl(c);
    // 供自动化验证读取的内部状态（只读快照 + 少量操作）
    (window as unknown as { __lab: unknown }).__lab = {
      getState: () => ({
        phase: c.phase,
        currentTime: c.currentTime,
        duration: c.duration,
        currentLevel: c.currentLevel,
        manualLevel: c.manualLevel,
        paused: c.paused,
        errorMessage: c.errorMessage,
        requests: c.requests.map((r) => ({ ...r })),
      }),
      seek: (t: number) => c.seek(t),
      play: () => videoRef.current!.play(),
      pause: () => videoRef.current!.pause(),
      setLevel: (i: number) => c.setLevel(i),
      load: (u: string) => c.load(u),
    };
    return () => c.destroy();
  }, []);

  const applyScenario = async (s: Scenario) => {
    await fetch('/api/faults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: s.rules, throttleKbps: s.throttleKbps }),
    });
    setFaultsVersion((v) => v + 1);
    setScenarioMsg(`${s.name}：${s.desc}`);
    setUrlInput(MASTER_URL);
    ctl?.load(MASTER_URL);
  };

  const phase: Phase = ctl?.phase ?? 'idle';
  const cur = ctl?.currentTime ?? 0;
  const dur = ctl?.duration ?? 0;

  return (
    <div className="page">
      <h1>HLS 点播排障实验台</h1>

      <section className="card">
        <div className="row">
          <input
            data-testid="manifest-input"
            className="url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="主清单地址，如 /media/sample/master.m3u8"
          />
          <button onClick={() => ctl?.load(urlInput)}>打开</button>
        </div>
        <div className="row scenarios">
          {SCENARIOS.map((s) => (
            <button key={s.key} onClick={() => applyScenario(s)} title={s.desc}>
              {s.name}
            </button>
          ))}
        </div>
        {scenarioMsg && <div className="hint">{scenarioMsg}</div>}
        {ctl && ctl.levels.length > 0 && (
          <div className="hint">
            总时长 {fmt(dur)} ｜ 可选码率：{ctl.levels.map((l) => l.label).join('、')} ｜ 当前清晰度：
            {ctl.currentLevel >= 0
              ? (ctl.levels.find((l) => l.index === ctl.currentLevel)?.label ?? `L${ctl.currentLevel}`)
              : '—'}
            {ctl.manualLevel === -1 ? '（自动）' : '（手动）'}
          </div>
        )}
      </section>

      {phase === 'failed' && (
        <div className="banner banner-error" data-testid="fatal-banner">
          <span>⚠ {ctl?.errorMessage}</span>
          <span>
            <button onClick={() => ctl?.recover()}>恢复播放</button>
            <button onClick={() => ctl?.reload()}>重新载入</button>
          </span>
        </div>
      )}
      {phase === 'retrying' && (
        <div className="banner banner-warn">分片加载失败，正在按上限重试，请稍候…</div>
      )}
      {phase === 'buffering' && <div className="banner banner-info">缓冲中…</div>}

      <section className="card">
        <video ref={videoRef} muted controls={false} width="100%" data-testid="video" />
        <div className="row controls">
          <button
            data-testid="play-pause"
            disabled={!ctl || phase === 'idle' || phase === 'loading'}
            onClick={() => {
              const v = videoRef.current!;
              if (v.paused) void v.play();
              else v.pause();
            }}
          >
            {ctl?.paused ? '播放' : '暂停'}
          </button>
          <input
            data-testid="seek-slider"
            type="range"
            min={0}
            max={dur || 0}
            step={0.1}
            value={Math.min(cur, dur || 0)}
            disabled={!dur}
            onChange={(e) => ctl?.seek(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span data-testid="time-display" className="time">
            {fmt(cur)} / {fmt(dur)}
          </span>
          <select
            data-testid="level-select"
            value={ctl?.manualLevel ?? -1}
            disabled={!ctl || ctl.levels.length === 0}
            onChange={(e) => ctl?.setLevel(Number(e.target.value))}
          >
            <option value={-1}>自动</option>
            {ctl?.levels.map((l) => (
              <option key={l.index} value={l.index}>
                {l.label}
              </option>
            ))}
          </select>
          <span className={`phase phase-${phase}`} data-testid="phase-badge">
            {PHASE_TEXT[phase]}
          </span>
        </div>
      </section>

      <div className="columns">
        <section className="card">
          <h2>分片请求记录（最近 {ctl ? Math.min(ctl.requests.length, 15) : 0} 条）</h2>
          <RequestLog requests={ctl?.requests ?? []} />
        </section>
        <section className="card">
          <h2>故障模拟</h2>
          <FaultPanel refreshKey={faultsVersion} onChanged={() => setFaultsVersion((v) => v + 1)} />
        </section>
      </div>
    </div>
  );
}
