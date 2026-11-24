#!/usr/bin/env node
// 无头端到端测试：启动 Vite dev server，用本机 Chrome（SwiftShader 软渲染）
// 加载 /e2e/test-runner.html，从控制台读取 TEST_RESULT 汇总。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}/e2e/test-runner.html`;

if (!existsSync(CHROME)) {
  console.error('未找到 Google Chrome，请修改 scripts/run-e2e.mjs 中的 CHROME 路径');
  process.exit(2);
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let exited = false;
const finish = (code) => {
  if (exited) return;
  exited = true;
  try { vite.kill(); } catch {}
  process.exit(code);
};

process.on('SIGINT', () => finish(130));

vite.stdout.on('data', async (chunk) => {
  if (!String(chunk).includes('Local:')) return;
  await sleep(600);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--enable-logging=stderr',
      '--virtual-time-budget=20000',
      '--dump-dom',
      URL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });
  chrome.on('close', () => {
    const line = stderr
      .split('\n')
      .find((l) => l.includes('TEST_RESULT'));
    if (!line) {
      console.error('未捕获到 TEST_RESULT，页面可能报错');
      finish(1);
      return;
    }
    const start = line.indexOf('{');
    let depth = 0;
    let end = -1;
    for (let i = start; i < line.length; i++) {
      if (line[i] === '{') depth++;
      else if (line[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const json = JSON.parse(line.slice(start, end));
    console.log(`\n端到端测试结果：${json.passed}/${json.total}`);
    for (const r of json.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
    }
    finish(json.passed === json.total ? 0 : 1);
  });
});

vite.stderr.on('data', (d) => process.stdout.write(d));
setTimeout(() => {
  console.error('测试超时');
  finish(1);
}, 45000);
