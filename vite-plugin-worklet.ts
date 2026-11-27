import { type Plugin } from 'vite';

/**
 * 把 `./x.ts?worklet` 入口编译成真正的独立 ES 模块，并返回可被
 * `audioWorklet.addModule(url)` 加载的同源 URL。
 *
 * Vite 默认不识别 AudioWorklet 入口：`?url` 会把 .ts 当静态资源，
 * 内联成 data: 且给出错误的 video/mp2t MIME，addModule 直接拒绝。
 * 这里在构建期把带 ?worklet 的模块解析为独立 chunk，dev 期返回源码 URL。
 */
const QUERY = '?worklet';

export function workletPlugin(): Plugin {
  return {
    name: 'audio-worklet-url',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.includes(QUERY)) return null;
      // 交给默认解析器定位真实文件，但保留 ?worklet 标记
      const clean = source.replace(QUERY, '');
      return this.resolve(clean, importer, { skipSelf: true }).then((r) =>
        r ? `${r.id}${QUERY}` : null,
      );
    },
    load(id) {
      if (!id.endsWith(QUERY)) return null;
      const file = id.slice(0, -QUERY.length);
      if (this.meta.watchMode) {
        // dev：直接返回源模块 URL，浏览器经 Vite 按需编译
        return `export default ${JSON.stringify(file)};`;
      }
      // build：标记为独立入口，emit 一个 JS chunk
      const ref = this.emitFile({
        type: 'chunk',
        id: file,
        name: 'tone-worklet',
      });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}
