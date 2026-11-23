import { Mapping } from '../model/types';
import { VoiceView } from '../audio/engine';

interface Props {
  mapping: Mapping;
  voices: VoiceView[];
  onStopAll: () => void;
}

/** 活动声音面板：连按时每次触发一条独立 voice，可看到当前并发与占用的素材 */
export function VoicesPanel({ mapping, voices, onStopAll }: Props) {
  const sampleName = (id: string): string => mapping.samples.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>活动声音 {voices.length}/{mapping.maxVoices}</h2>
        <span className="spacer" />
        <button className="tiny" onClick={onStopAll} disabled={voices.length === 0}>
          全部停止
        </button>
      </div>
      {voices.length === 0 && <div className="muted">当前没有在响的声音</div>}
      {voices.map((v) => (
        <div className="voice-item" key={v.id}>
          <div>
            <b className="mono">#{v.id}</b> <span className="muted">press #{v.pressId}</span> · v{v.velocity}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {v.sampleIds.map(sampleName).join(' + ')}
          </div>
        </div>
      ))}
      <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
        并发达到上限时，最旧的声音会被立即结束，事件台账中记为「偷旧声」。松键只结束同一 press 的声音。
      </p>
    </div>
  );
}
