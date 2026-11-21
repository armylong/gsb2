// 开发服务器:esbuild 增量构建 + 静态服务,避免 CLI serve 在 stdin 关闭后退出的问题。
import esbuild from 'esbuild';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  sourcemap: true,
  logLevel: 'info',
});

const { port } = await ctx.serve({ servedir: '.', port: 8000 });
console.log(`\n调试页已启动: http://localhost:${port}\n(Ctrl+C 停止)`);
