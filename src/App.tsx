import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mapping } from './model/types';
import { defaultMapping } from './state/preset';
import { engine, useEngineSnapshot } from './state/useEngine';
import { loadMapping, saveMapping } from './audio/storage';
import { TopBar } from './components/TopBar';
import { VelocityPad } from './components/VelocityPad';
import { ZoneChart } from './components/ZoneChart';
import { ZoneEditor } from './components/ZoneEditor';
import { SampleLibrary } from './components/SampleLibrary';
import { EventLog } from './components/EventLog';
import { VoicesPanel } from './components/VoicesPanel';
import { SequencePanel } from './components/SequencePanel';
import { ValidationPanel } from './components/ValidationPanel';

export default function App() {
  const [mapping, setMapping] = useState<Mapping>(() => defaultMapping());
  const [velocity, setVelocity] = useState(64);
  const [bootError, setBootError] = useState<string | null>(null);
  const snap = useEngineSnapshot();
  const skipAutosave = useRef(true);

  // 启动时从 IndexedDB 恢复（模拟重开浏览器继续检查）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await loadMapping();
        if (cancelled) return;
        if (stored?.mapping) {
          const m = stored.mapping as Mapping;
          setMapping(m);
          engine.setMapping(m);
          engine.setSavedMeta(stored.savedAt);
        } else {
          engine.setMapping(mapping);
        }
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err));
        engine.setMapping(mapping);
      } finally {
        skipAutosave.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyMapping = useCallback((m: Mapping) => {
    setMapping(m);
    engine.setMapping(m);
  }, []);

  // 自动保存（防抖），手动"保存映射"立即写
  useEffect(() => {
    if (skipAutosave.current) return;
    const id = setTimeout(() => {
      engine.setSavedMeta(engine.getSnapshot().lastSavedAt, true);
      void saveMapping(mapping).then((at) => engine.setSavedMeta(at, false));
    }, 800);
    return () => clearTimeout(id);
  }, [mapping]);

  const saveNow = useCallback(() => {
    engine.setSavedMeta(engine.getSnapshot().lastSavedAt, true);
    void saveMapping(mapping).then((at) => engine.setSavedMeta(at, false));
  }, [mapping]);

  const reload = useCallback(async () => {
    const stored = await loadMapping();
    if (!stored) {
      setBootError('IndexedDB 中没有已保存的映射');
      return;
    }
    const m = stored.mapping as Mapping;
    setBootError(null);
    applyMapping(m);
    engine.setSavedMeta(stored.savedAt);
    engine.resetRotation();
  }, [applyMapping]);

  const onTrigger = useCallback((v: number) => engine.trigger(v), []);
  const onRelease = useCallback((pressId: number | null) => {
    if (pressId !== null) engine.release(pressId);
  }, []);

  const zoneLabels = useMemo(
    () => Object.fromEntries(mapping.zones.map((z) => [z.id, z.label])),
    [mapping.zones],
  );

  return (
    <div className="app">
      <TopBar
        mapping={mapping}
        onMappingChange={applyMapping}
        initialized={snap.initialized}
        saving={snap.saving}
        lastSavedAt={snap.lastSavedAt}
        onSave={saveNow}
        onReload={() => void reload()}
      />
      {bootError && (
        <div className="issue warning">恢复失败：{bootError}（当前使用默认映射，保存一次即可覆盖）</div>
      )}

      <div className="grid">
        <div>
          <VelocityPad
            mapping={mapping}
            velocity={velocity}
            onVelocityChange={setVelocity}
            onTrigger={onTrigger}
            onRelease={onRelease}
            engineReady={snap.initialized}
            onInit={() => void engine.init()}
          />
          <ZoneChart mapping={mapping} velocity={velocity} />
          <ValidationPanel mapping={mapping} />
          <SequencePanel
            sequence={snap.sequence}
            counters={snap.counters}
            zoneLabels={zoneLabels}
            onReset={() => engine.resetRotation()}
            onReplay={() => void engine.replaySequence()}
          />
        </div>

        <div>
          <ZoneEditor mapping={mapping} onChange={applyMapping} sampleStates={snap.sampleStates} />
        </div>

        <div>
          <VoicesPanel mapping={mapping} voices={snap.voices} onStopAll={() => engine.stopAll()} />
          <SampleLibrary mapping={mapping} onChange={applyMapping} sampleStates={snap.sampleStates} />
          <EventLog />
        </div>
      </div>
    </div>
  );
}
