#!/usr/bin/env node
// 0단계 검증: 내 PC에서 두 CLI가 허브 방식(비대화형 + JSON 출력 + 세션 재개)으로 동작하는지 확인
// 사용법: node scripts/verify.mjs          (짧은 실제 요청 2회씩 실행 → 구독 사용량 소량 소모)
//        node scripts/verify.mjs --no-run (설치/버전만 확인)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from '../lib/agents.js';

const NO_RUN = process.argv.includes('--no-run');
const only = process.argv.find((a) => a === 'claude' || a === 'codex');
const IS_WIN = process.platform === 'win32';

function run(bin, args, { cwd, input, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(bin, args, { cwd, shell: IS_WIN, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out, err: e.message });
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function parseAll(ad, out) {
  const evs = [];
  let bad = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(...ad.parse(JSON.parse(line))); } catch { bad++; }
  }
  return { evs, bad };
}

const line = (ok, msg) => console.log(`  ${ok ? '✅' : '❌'} ${msg}`);
let failures = 0;
const check = (ok, msg) => { line(ok, msg); if (!ok) failures++; return ok; };

console.log(`AI Hub 0단계 검증 — Node ${process.version} / ${process.platform}\n`);
check(Number(process.versions.node.split('.')[0]) >= 18, 'Node 18 이상');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-verify-'));
for (const ad of Object.values(AGENTS)) {
  if (only && ad.id !== only) continue;
  console.log(`\n[${ad.name}]  실행 파일: ${ad.bin()}`);
  const v = await run(ad.bin(), ['--version'], { cwd: tmp, timeoutMs: 20_000 });
  if (!check(v.code === 0, `설치 확인 ${v.code === 0 ? v.out.trim().split('\n')[0] : `— ${v.err.trim().slice(0, 200) || '명령을 찾을 수 없음'}`}`)) continue;
  if (NO_RUN) continue;

  // 1) 새 작업 (읽기 전용)
  const r1 = await run(ad.bin(), ad.buildArgs({ mode: 'read' }), { cwd: tmp, input: 'Reply with exactly: HUB_OK_1' });
  const p1 = parseAll(ad, r1.out);
  const sid = p1.evs.find((e) => e.kind === 'session')?.id;
  const res1 = p1.evs.find((e) => e.kind === 'result');
  const txt1 = p1.evs.filter((e) => e.kind === 'text').map((e) => e.text).join(' ');
  if (!check(r1.code === 0, `비대화형 실행 (종료 코드 ${r1.code})`)) console.log('     stderr:', r1.err.trim().slice(0, 400) || '(없음)', '\n     stdout:', r1.out.slice(0, 400));
  check(p1.evs.length > 0 && p1.bad === 0, `JSON 이벤트 파싱 (${p1.evs.length}개, 실패 ${p1.bad}줄)`);
  check(!!sid, `세션 ID 수집 ${sid || ''}`);
  check(!!res1 && res1.ok, '완료(result) 이벤트 수신');
  check(/HUB_OK_1/.test(txt1 + (res1?.text || '')), '응답 텍스트 수신');
  if (!sid) continue;

  // 2) 같은 세션 이어가기
  const r2 = await run(ad.bin(), ad.buildArgs({ mode: 'read', resumeId: sid }), { cwd: tmp, input: 'Reply with exactly: HUB_OK_2' });
  const p2 = parseAll(ad, r2.out);
  const sid2 = p2.evs.find((e) => e.kind === 'session')?.id;
  const txt2 = p2.evs.filter((e) => e.kind === 'text' || e.kind === 'result').map((e) => e.text).join(' ');
  if (!check(r2.code === 0 && /HUB_OK_2/.test(txt2), '세션 이어가기(resume)')) console.log('     stderr:', r2.err.trim().slice(0, 400));
  check(sid2 === sid, `같은 세션 유지 (${sid2 === sid ? '동일' : `다름: ${sid2}`})`);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n❌ ${failures}개 항목 실패 — 위 메시지를 확인하세요.` : '\n✅ 모든 항목 통과 — `npm start`로 허브를 실행하세요.');
process.exitCode = failures ? 1 : 0;
