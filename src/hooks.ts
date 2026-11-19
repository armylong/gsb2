import { useEffect, useRef, useState } from 'react';
import type { BuildResult, SourceFrameInfo } from '../shared/types';
import * as api from './lib/api';

export type Notice = { kind: 'info' | 'error' | 'success'; text: string };

export function useFrames() {
  const [frames, setFrames] = useState<SourceFrameInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = async () => {
    const { frames: next } = await api.getFrames();
    setFrames(next);
    return next;
  };

  useEffect(() => {
    refresh().catch((error: Error) => setNotice({ kind: 'error', text: error.message }));
  }, []);

  const run = async (task: () => Promise<Notice>) => {
    setBusy(true);
    try {
      setNotice(await task());
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (files: FileList | File[]) =>
    run(async () => {
      const payload = await api.filesToPayload(files);
      const result = await api.importFiles(payload);
      const lines = [`已加入 ${result.frames.length} 张图片`];
      if (result.duplicates.length > 0) {
        lines.push(
          `重复（已存在相同内容与路径，未覆盖）：` +
            result.duplicates.map((entry) => `${entry.sourceKey}`).join('; '),
        );
      }
      if (result.rejected.length > 0) {
        lines.push(`拒绝 ${result.rejected.length} 张：` + result.rejected.map((r) => `${r.name} (${r.message})`).join('; '));
      }
      return { kind: result.rejected.length > 0 ? 'error' : result.duplicates.length > 0 ? 'info' : 'success', text: lines.join('。') };
    });

  const addSamples = () =>
    run(async () => {
      const result = await api.loadSamples();
      const fresh = result.frames.length - result.duplicates.length;
      return {
        kind: 'success',
        text:
          `已加入 ${result.frames.length} 张自生成示例素材（其中 ${fresh} 张新增，` +
          `${result.duplicates.length} 张此前已存在）：含全透明帧、长条、同名不同目录文件`,
      };
    });

  const remove = (ids: string[]) =>
    run(async () => {
      await api.removeFrames(ids);
      return { kind: 'info', text: `已移除 ${ids.length} 张图片` };
    });

  return { frames, busy, notice, setNotice, refresh, addFiles, addSamples, remove };
}

export function useBuild() {
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRun = useRef(0);

  const run = async (settings: Parameters<typeof api.pack>[0], frameIds?: string[]) => {
    const seq = ++lastRun.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.pack(settings, frameIds);
      if (seq === lastRun.current) setBuild(result);
      return result;
    } catch (caught) {
      if (seq === lastRun.current) setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      if (seq === lastRun.current) setBusy(false);
    }
  };

  const clear = () => setBuild(null);

  return { build, busy, error, run, clear };
}
