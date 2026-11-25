/**
 * 浏览器测试编排：启动静态服务器 → 依次跑两个 CDP 测试 → 关闭服务器。
 * 仅依赖 Node 内置能力与本机 Google Chrome。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 8123;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

function runNode(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code));
  });
}

server.listen(PORT, async () => {
  console.log(`[test-server] http://127.0.0.1:${PORT}`);
  let failed = 0;
  for (const script of ['cdp-test.cjs', 'cdp-dom-test.cjs']) {
    const code = await runNode(script);
    if (code !== 0) failed += 1;
  }
  server.close();
  console.log(failed === 0 ? '\n浏览器测试全部通过' : `\n${failed} 个浏览器测试失败`);
  process.exit(failed === 0 ? 0 : 1);
});
