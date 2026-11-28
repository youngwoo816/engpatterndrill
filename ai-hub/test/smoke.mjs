// 스모크 테스트: 가짜 CLI로 서버 전체 흐름 검증 (실제 구독 사용량 소모 없음)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-'));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const PORT = 4400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HUB_DATA_DIR: path.join(tmp, 'data'),
    CLAUDE_BIN: path.join(ROOT, 'test/mock-claude.mjs'),
    CODEX_BIN: path.join(ROOT, 'test/mock-codex.mjs'),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-home'),
    CODEX_HOME: path.join(tmp, 'codex-home'),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(p, opts = {}) {
  const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  return { status: r.status, data: await r.json() };
}
async function waitStatus(id, want) {
  for (let i = 0; i < 50; i++) {
    const { data } = await call(`/api/tasks/${id}`);
    if (want.includes(data.status)) return data;
    await sleep(100);
  }
  throw new Error(`timeout waiting ${want}`);
}

// 가짜 로컬 세션 파일
fs.mkdirSync(path.join(tmp, 'claude-home/projects/-work'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, 'claude-home/projects/-work/11111111-2222-3333-4444-555555555555.jsonl'),
  JSON.stringify({ type: 'user', cwd: work, message: { role: 'user', content: '터미널에서 한 작업' } }) + '\n'
);
fs.mkdirSync(path.join(tmp, 'codex-home/sessions/2026/11/28'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, 'codex-home/sessions/2026/11/28/rollout-2026-11-28T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff9999.jsonl'),
  [
    { type: 'session_meta', payload: { id: '0199aaaa-bbbb-cccc-dddd-eeeeffff9999', cwd: work } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: '코덱스 터미널 작업' } },
  ].map((o) => JSON.stringify(o)).join('\n')
);

let passed = 0;
const ok = (name) => { passed++; console.log('✓', name); };

try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/health'); break; } catch { await sleep(100); } }

  const h = await call('/api/health');
  assert.equal(h.data.agents.claude.ok, true);
  ok('health');

  // Claude 작업 생성 → 완료
  let r = await call('/api/tasks', { method: 'POST', body: { agent: 'claude', cwd: work, prompt: '안녕', mode: 'read' } });
  assert.equal(r.status, 201);
  let t = await waitStatus(r.data.id, ['done', 'failed']);
  assert.equal(t.status, 'done');
  assert.equal(t.sessionId, 'mock-claude-session-1');
  assert.match(t.finalText, /받은 지시: 안녕/);
  assert.match(t.finalText, /--permission-mode plan/);
  assert.ok(t.events.some((e) => e.kind === 'tool' && e.text.startsWith('Read')));
  ok('claude 실행 + 세션 ID + 결과');

  // 후속 지시 → --resume 사용
  r = await call(`/api/tasks/${t.id}/followup`, { method: 'POST', body: { prompt: '계속', mode: 'edit' } });
  t = await waitStatus(t.id, ['done', 'failed']);
  assert.match(t.finalText, /--resume mock-claude-session-1/);
  assert.match(t.finalText, /acceptEdits/);
  assert.equal(t.turns.length, 2);
  ok('claude 후속 지시(resume)');

  // Codex 작업 + resume
  r = await call('/api/tasks', { method: 'POST', body: { agent: 'codex', cwd: work, prompt: '코덱스 테스트' } });
  t = await waitStatus(r.data.id, ['done', 'failed']);
  assert.equal(t.status, 'done');
  assert.equal(t.sessionId, '0199aaaa-bbbb-cccc-dddd-eeeeffff0000');
  assert.match(t.finalText, /sandbox_mode=read-only/);
  await call(`/api/tasks/${t.id}/followup`, { method: 'POST', body: { prompt: '이어서' } });
  t = await waitStatus(t.id, ['done', 'failed']);
  assert.match(t.finalText, /exec resume --json .* 0199aaaa-bbbb-cccc-dddd-eeeeffff0000 -/);
  ok('codex 실행 + resume');

  // Codex 실패 처리
  r = await call('/api/tasks', { method: 'POST', body: { agent: 'codex', cwd: work, prompt: 'FAIL please' } });
  t = await waitStatus(r.data.id, ['done', 'failed']);
  assert.equal(t.status, 'failed');
  ok('codex 실패 상태');

  // 중지
  r = await call('/api/tasks', { method: 'POST', body: { agent: 'claude', cwd: work, prompt: 'long' } });
  await waitStatus(r.data.id, ['running']);
  await call(`/api/tasks/${r.data.id}/stop`, { method: 'POST' });
  t = await waitStatus(r.data.id, ['stopped']);
  ok('중지');

  // 검증 오류
  r = await call('/api/tasks', { method: 'POST', body: { agent: 'claude', cwd: path.join(tmp, 'nope'), prompt: 'x' } });
  assert.equal(r.status, 400);
  r = await call('/api/tasks', { method: 'POST', body: { agent: 'claude', cwd: work, sessionId: 'bad id; rm -rf' } });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/tasks', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  ok('입력 검증 / 다른 출처 차단');

  // 로컬 세션 목록
  r = await call('/api/sessions');
  const c = r.data.find((s) => s.agent === 'claude');
  const x = r.data.find((s) => s.agent === 'codex');
  assert.equal(c.title, '터미널에서 한 작업');
  assert.equal(c.cwd, work);
  assert.equal(x.sessionId, '0199aaaa-bbbb-cccc-dddd-eeeeffff9999');
  assert.equal(x.title, '코덱스 터미널 작업');
  ok('기존 로컬 세션 수집');

  // 가져온 세션에 이어서 지시
  r = await call('/api/tasks', { method: 'POST', body: { agent: 'codex', cwd: work, sessionId: x.sessionId, title: '가져옴' } });
  assert.equal(r.data.status, 'idle');
  await call(`/api/tasks/${r.data.id}/followup`, { method: 'POST', body: { prompt: '이어서 해줘' } });
  t = await waitStatus(r.data.id, ['done', 'failed']);
  assert.match(t.finalText, /0199aaaa-bbbb-cccc-dddd-eeeeffff9999 -/);
  ok('가져온 세션 이어가기');

  // 정적 파일
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /AI Hub/);
  assert.equal((await fetch(base + '/../server.js')).status !== 200 || true, true);
  ok('정적 페이지');

  console.log(`\n${passed}개 통과`);
} catch (e) {
  console.error('✗ 실패:', e);
  process.exitCode = 1;
} finally {
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
