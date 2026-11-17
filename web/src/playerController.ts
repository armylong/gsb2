import Hls from 'hls.js';

export type ReqStatus = 'pending' | 'ok' | 'retrying' | 'error';
export type Phase = 'idle' | 'loading' | 'ready' | 'buffering' | 'retrying' | 'failed';

export interface ReqEntry {
  id: number;
  key: string; // `${level}:${sn}`，同一逻辑分片重试时复用同一条记录
  level: number;
  levelLabel: string;
  sn: number;
  rangeStart: number; // 内容区间（秒）
  rangeEnd: number;
  attempt: number; // 第几次请求（含重试）
  startTs: number;
  endTs?: number;
  status: ReqStatus;
  error?: string;
}

export interface LevelInfo {
  index: number;
  label: string;
  bitrate: number;
  height: number;
}

const MAX_REQUESTS = 60;

/**
 * 包装 hls.js：
 * - 每次 load() 生成新实例并销毁旧实例（token 守卫），旧实例迟到的回调一律丢弃，
 *   保证连续定位 / 切码率 / 换清单时，只有最后一次操作生效；
 * - 从不主动调用 video.play()，暂停状态下迟到的分片不会擅自恢复播放；
 * - 分片重试上限由 fragLoadingMaxRetry 控制，超限后进入 failed 态，等待用户处理。
 */
export class PlayerController {
  phase: Phase = 'idle';
  errorMessage = '';
  levels: LevelInfo[] = [];
  currentLevel = -1; // 实际正在播放的清晰度（LEVEL_SWITCHED）
  manualLevel = -1; // 用户选择：-1 = 自动
  duration = 0;
  requests: ReqEntry[] = [];

  private hls: Hls | null = null;
  private url = '';
  private token = 0;
  private reqSeq = 0;
  private pendingSeek: number | null = null;
  private lastFatalType: string | null = null;

  constructor(
    private video: HTMLVideoElement,
    private notify: () => void,
  ) {
    video.addEventListener('waiting', () => {
      if (this.phase === 'ready' || this.phase === 'retrying') {
        this.phase = 'buffering';
        this.notify();
      }
    });
    video.addEventListener('playing', () => {
      if (this.phase !== 'failed' && this.phase !== 'loading') {
        this.phase = 'ready';
        this.notify();
      }
    });
    video.addEventListener('timeupdate', () => this.notify());
    video.addEventListener('loadedmetadata', () => {
      this.duration = video.duration;
      if (this.pendingSeek != null && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(this.pendingSeek, Math.max(0, video.duration - 0.5));
      }
      this.pendingSeek = null;
      this.notify();
    });
  }

  get currentTime() {
    return this.video.currentTime;
  }
  get paused() {
    return this.video.paused;
  }
  get currentUrl() {
    return this.url;
  }

  load(url: string) {
    this.destroyHls();
    const myToken = ++this.token;
    this.url = url;
    this.phase = 'loading';
    this.errorMessage = '';
    this.requests = [];
    this.levels = [];
    this.currentLevel = -1;
    this.manualLevel = -1;
    this.duration = 0;
    this.lastFatalType = null;
    this.notify();

    const hls = new Hls({
      // 重试上限：首次 + 3 次重试，之后转为 fatal，由用户决定恢复或重载
      fragLoadingMaxRetry: 3,
      fragLoadingRetryDelay: 800,
      manifestLoadingMaxRetry: 1,
      levelLoadingMaxRetry: 2,
    });
    this.hls = hls;
    const alive = () => this.token === myToken && this.hls === hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!alive()) return;
      this.levels = hls.levels.map((l, i) => ({
        index: i,
        bitrate: l.bitrate,
        height: l.height || 0,
        label: l.height
          ? `${l.height}p · ${Math.round(l.bitrate / 1000)} kbps`
          : `${Math.round(l.bitrate / 1000)} kbps`,
      }));
      this.phase = 'ready';
      this.notify();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      if (!alive()) return;
      this.currentLevel = data.level;
      this.notify();
    });

    hls.on(Hls.Events.FRAG_LOADING, (_e, data) => {
      if (!alive()) return;
      const frag = data.frag;
      if (frag.sn === 'initSegment') return;
      const key = `${frag.level}:${frag.sn}`;
      const retrying = [...this.requests]
        .reverse()
        .find((r) => r.key === key && (r.status === 'retrying' || r.status === 'error'));
      if (retrying) {
        retrying.attempt += 1;
        retrying.status = 'pending';
        retrying.startTs = performance.now();
        retrying.endTs = undefined;
        retrying.error = undefined;
      } else {
        this.requests.push({
          id: ++this.reqSeq,
          key,
          level: frag.level,
          levelLabel: this.levelLabel(frag.level),
          sn: frag.sn as number,
          rangeStart: frag.start,
          rangeEnd: frag.start + frag.duration,
          attempt: 1,
          startTs: performance.now(),
          status: 'pending',
        });
        if (this.requests.length > MAX_REQUESTS) {
          this.requests.splice(0, this.requests.length - MAX_REQUESTS);
        }
      }
      this.notify();
    });

    hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      if (!alive()) return;
      const frag = data.frag;
      if (frag.sn === 'initSegment') return;
      const entry = [...this.requests]
        .reverse()
        .find((r) => r.key === `${frag.level}:${frag.sn}` && r.status === 'pending');
      if (entry) {
        entry.status = 'ok';
        entry.endTs = performance.now();
      }
      if (this.phase === 'retrying') this.phase = 'ready';
      this.notify();
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!alive()) return;
      const frag = (data as { frag?: { level: number; sn: number | string } }).frag;
      if (frag && frag.sn !== 'initSegment') {
        this.markFragError(frag.level, frag.sn as number, data.fatal, data.details);
      }
      if (data.fatal) {
        this.phase = 'failed';
        this.lastFatalType = data.type;
        this.errorMessage = this.friendlyError(data);
      } else if (this.phase !== 'failed') {
        this.phase = 'retrying';
      }
      this.notify();
    });

    hls.loadSource(url);
    hls.attachMedia(this.video);
  }

  /** 手动选择清晰度：-1 为自动。切换只影响后续分片，播放位置不变。 */
  setLevel(index: number) {
    this.manualLevel = index;
    if (this.hls) this.hls.currentLevel = index;
    this.notify();
  }

  seek(t: number) {
    this.video.currentTime = t;
  }

  /**  fatal 后尝试从当前位置继续（不自动播放，保持用户原来的播放/暂停状态） */
  recover() {
    if (!this.hls || this.phase !== 'failed') return;
    this.errorMessage = '';
    this.phase = 'buffering';
    if (this.lastFatalType === 'mediaError') {
      this.hls.recoverMediaError();
    } else {
      this.hls.startLoad(this.video.currentTime);
    }
    this.notify();
  }

  /** 重新载入当前清单，并尽量回到之前的位置 */
  reload() {
    if (!this.url) return;
    this.pendingSeek = this.video.currentTime || 0;
    this.load(this.url);
  }

  destroy() {
    this.token++;
    this.destroyHls();
  }

  private destroyHls() {
    if (this.hls) {
      this.hls.destroy(); // 会中断进行中的请求，旧实例事件随后被 token 守卫丢弃
      this.hls = null;
    }
  }

  private levelLabel(level: number) {
    const info = this.levels.find((l) => l.index === level);
    return info ? info.label : `L${level}`;
  }

  private markFragError(level: number, sn: number, fatal: boolean, details: string) {
    const key = `${level}:${sn}`;
    const entry = [...this.requests]
      .reverse()
      .find((r) => r.key === key && (r.status === 'pending' || r.status === 'retrying'));
    if (entry) {
      entry.status = fatal ? 'error' : 'retrying';
      entry.endTs = performance.now();
      entry.error = details;
    }
  }

  private friendlyError(data: { details: string; response?: { code?: number } }): string {
    const code = data.response?.code;
    const httpInfo = code ? `（HTTP ${code}）` : '';
    switch (data.details) {
      case 'manifestLoadError':
      case 'manifestLoadTimeOut':
        return `无法加载清单${httpInfo}。请确认：地址填写正确、本地服务已启动、目标确实是 m3u8 清单文件。`;
      case 'manifestParsingError':
        return '清单内容无法解析：文件不是有效的 HLS 清单，或包含本播放器不支持的特性（仅限点播、不含 DRM）。';
      case 'levelLoadError':
      case 'levelLoadTimeOut':
        return `无法加载某个清晰度的媒体清单${httpInfo}。请确认清单中的相对地址可以正常访问。`;
      case 'fragLoadError':
      case 'fragLoadTimeOut':
        return '分片多次加载失败，已达到重试上限。可在右侧面板关闭对应故障后点击“恢复播放”，或“重新载入”。';
      case 'bufferStalledError':
      case 'bufferNudgeOnStall':
        return '缓冲长时间没有进展。请检查是否有分片持续不可用，处理后点击“恢复播放”。';
      default:
        return `播放出错（${data.details}）。可尝试“恢复播放”或“重新载入”。`;
    }
  }
}
