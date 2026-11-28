#!/usr/bin/env node
// AI Hub 로컬 서버 — 외부 패키지 없음 (Node 18+)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTS, MODES, isSafeId } from './lib/agents.js';
import { Runner } from './lib/runner.js';
import { listLocalSessions } from './lib/sessions.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const TOKEN = process.env.HUB_TOKEN || '';
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(ROOT, 'data');
const ALLOWED_ROOTS = (process.env.ALLOWED_ROOTS || '')
  .split(path.delimiter)
  .filter(Boolean)
  .map((p) => path.resolve(p));
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

if (!LOCAL_HOSTS.has(HOST) && !TOKEN) {
  console.error('HOST를 외부 주소로 열 때는 HUB_TOKEN을 반드시 설정해야 합니다.');
  process.exit(1);
}

const runner = new Runner({ dataDir: DATA_DIR, maxPerAgent: Number(process.env.MAX_PER_AGENT || 1) });

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('요청이 너무 큽니다'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 형식 오류'));
      }
    });
  });
}

function checkCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') throw new Error('작업 폴더를 입력하세요');
  const p = path.resolve(cwd.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'));
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`폴더가 없습니다: ${p}`);
  }
  if (!st.isDirectory()) throw new Error(`폴더가 아닙니다: ${p}`);
  if (ALLOWED_ROOTS.length && !ALLOWED_ROOTS.some((r) => p === r || p.startsWith(r + path.sep)))
    throw new Error('허용되지 않은 폴더입니다 (ALLOWED_ROOTS 확인)');
  return p;
}

function run(cmd, args, cwd, max = 400_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 8e6, timeout: 20_000, windowsHide: true, shell: process.platform === 'win32' && cmd !== 'git' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').slice(0, max), err: String(stderr || err?.message || '') });
    });
  });
}

let healthCache = null;
async function health() {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.data;
  const data = {};
  for (const a of Object.values(AGENTS)) {
    const r = await run(a.bin(), ['--version'], ROOT);
    data[a.id] = { name: a.name, ok: r.ok, version: r.out.trim().split('\n')[0] || null, error: r.ok ? null : r.err.slice(0, 200) };
  }
  healthCache = { at: Date.now(), data };
  return data;
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
runner.on('task', (t) => broadcast('task', t));
runner.on('event', (e) => broadcast('event', e));
runner.on('removed', (e) => broadcast('removed', e));
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000);

// ---------- routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (parts[1] === 'health' && m === 'GET') return send(res, 200, { agents: await health(), modes: MODES, platform: process.platform });

  if (parts[1] === 'stream' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (parts[1] === 'sessions' && m === 'GET') {
    const agent = url.searchParams.get('agent') || undefined;
    return send(res, 200, listLocalSessions(agent, 40));
  }

  if (parts[1] === 'tasks') {
    const id = parts[2];
    if (!id && m === 'GET') return send(res, 200, runner.list(url.searchParams.get('agent') || undefined));
    if (!id && m === 'POST') {
      const b = await readBody(req);
      if (!AGENTS[b.agent]) throw new Error('agent는 claude 또는 codex');
      if (b.mode && !MODES[b.mode]) throw new Error('잘못된 권한 모드');
      if (!b.sessionId && !b.prompt?.trim()) throw new Error('프롬프트를 입력하세요');
      if (b.sessionId && !isSafeId(b.sessionId)) throw new Error('잘못된 세션 ID');
      const t = runner.create({ agent: b.agent, cwd: checkCwd(b.cwd), prompt: b.prompt?.trim(), mode: b.mode, title: b.title, sessionId: b.sessionId });
      return send(res, 201, runner.summary(t));
    }
    const task = runner.get(id);
    if (!task) return send(res, 404, { error: '작업 없음' });
    const action = parts[3];
    if (!action && m === 'GET') return send(res, 200, task);
    if (!action && m === 'DELETE') {
      runner.remove(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'followup' && m === 'POST') {
      const b = await readBody(req);
      if (!b.prompt?.trim()) throw new Error('프롬프트를 입력하세요');
      if (b.mode && !MODES[b.mode]) throw new Error('잘못된 권한 모드');
      return send(res, 200, runner.summary(runner.followup(id, b.prompt.trim(), b.mode)));
    }
    if (action === 'stop' && m === 'POST') return send(res, 200, runner.summary(runner.stop(id)));
    if (action === 'diff' && m === 'GET') {
      const st = await run('git', ['status', '--porcelain=v1', '-uall'], task.cwd, 50_000);
      if (!st.ok) return send(res, 200, { git: false, error: 'Git 저장소가 아니거나 git이 없습니다' });
      const diff = await run('git', ['diff', '--no-color', 'HEAD'], task.cwd);
      return send(res, 200, { git: true, status: st.out, diff: diff.ok ? diff.out : '', truncated: diff.out.length >= 400_000 });
    }
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (TOKEN && req.headers['x-hub-token'] !== TOKEN && url.searchParams.get('token') !== TOKEN)
        return send(res, 401, { error: '인증 필요' });
      // 다른 사이트에서의 요청 차단 (CSRF 방지)
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: '다른 출처의 요청은 거부됩니다' });
      return await api(req, res, url);
    }
    serveStatic(req, res, url);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Hub 실행 중 → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Claude: ${AGENTS.claude.bin()} / Codex: ${AGENTS.codex.bin()} / 데이터: ${DATA_DIR}`);
});
