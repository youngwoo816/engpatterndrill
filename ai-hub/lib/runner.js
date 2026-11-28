// 작업 실행기: CLI 프로세스 실행, 큐(에이전트별 동시 실행 제한), 상태 저장, 이벤트 브로드캐스트
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENTS, isSafeId } from './agents.js';

const IS_WIN = process.platform === 'win32';

export class Runner extends EventEmitter {
  constructor({ dataDir, maxPerAgent = 1 }) {
    super();
    this.dir = path.join(dataDir, 'tasks');
    fs.mkdirSync(this.dir, { recursive: true });
    this.maxPerAgent = maxPerAgent;
    this.tasks = new Map();
    this.procs = new Map(); // taskId -> child
    this.queue = []; // { taskId, prompt }
    this.saveTimers = new Map();
    this.load();
  }

  load() {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        // 서버 재시작 시 실행 중이던 작업은 중단 처리
        if (t.status === 'running' || t.status === 'queued') {
          t.status = 'stopped';
          t.events.push({ t: Date.now(), kind: 'error', text: '서버 재시작으로 중단됨' });
        }
        this.tasks.set(t.id, t);
      } catch {}
    }
  }

  save(task, now = false) {
    clearTimeout(this.saveTimers.get(task.id));
    const write = () => fs.writeFileSync(path.join(this.dir, `${task.id}.json`), JSON.stringify(task));
    if (now) return write();
    this.saveTimers.set(task.id, setTimeout(write, 300));
  }

  summary(t) {
    const { events, ...rest } = t;
    return { ...rest, eventCount: events.length };
  }

  list(agent) {
    return [...this.tasks.values()]
      .filter((t) => !agent || t.agent === agent)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => this.summary(t));
  }

  get(id) {
    return this.tasks.get(id);
  }

  touch(task) {
    task.updatedAt = Date.now();
    this.emit('task', this.summary(task));
    this.save(task);
  }

  pushEvent(task, ev) {
    const e = { t: Date.now(), turn: task.turns.length - 1, ...ev };
    task.events.push(e);
    this.emit('event', { taskId: task.id, ev: e });
  }

  create({ agent, cwd, prompt, mode, title, sessionId }) {
    if (!AGENTS[agent]) throw new Error('알 수 없는 에이전트');
    if (sessionId && !isSafeId(sessionId)) throw new Error('잘못된 세션 ID');
    const task = {
      id: crypto.randomUUID(),
      agent,
      cwd,
      mode: mode || 'read',
      title: (title || prompt || '').split('\n')[0].slice(0, 80) || '(제목 없음)',
      sessionId: sessionId || null,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
      events: [],
      finalText: '',
      meta: null,
    };
    this.tasks.set(task.id, task);
    if (prompt) this.enqueue(task, prompt);
    else this.touch(task);
    return task;
  }

  followup(id, prompt, mode) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('작업 없음');
    if (task.status === 'running' || task.status === 'queued') throw new Error('작업이 아직 진행 중입니다');
    if (mode) task.mode = mode;
    this.enqueue(task, prompt);
    return task;
  }

  enqueue(task, prompt) {
    task.turns.push({ prompt, status: 'queued', queuedAt: Date.now() });
    task.status = 'queued';
    this.pushEvent(task, { kind: 'prompt', text: prompt });
    this.queue.push(task.id);
    this.touch(task);
    this.pump();
  }

  runningCount(agent) {
    let n = 0;
    for (const id of this.procs.keys()) if (this.tasks.get(id)?.agent === agent) n++;
    return n;
  }

  pump() {
    for (let i = 0; i < this.queue.length; ) {
      const task = this.tasks.get(this.queue[i]);
      if (!task || task.status !== 'queued') {
        this.queue.splice(i, 1);
        continue;
      }
      if (this.runningCount(task.agent) < this.maxPerAgent) {
        this.queue.splice(i, 1);
        this.start(task);
      } else i++;
    }
  }

  start(task) {
    const ad = AGENTS[task.agent];
    const turn = task.turns[task.turns.length - 1];
    const args = ad.buildArgs({ mode: task.mode, resumeId: task.sessionId });
    turn.status = 'running';
    turn.startedAt = Date.now();
    task.status = 'running';
    this.touch(task);

    let child;
    try {
      child = spawn(ad.bin(), args, {
        cwd: task.cwd,
        env: process.env,
        shell: IS_WIN, // Windows의 npm 설치 CLI(.cmd) 실행용. 인자는 고정 토큰과 검증된 ID뿐
        windowsHide: true,
      });
    } catch (e) {
      return this.finish(task, false, `실행 실패: ${e.message}`);
    }
    this.procs.set(task.id, child);

    let buf = '';
    let stderr = '';
    let lastText = '';
    let gotResult = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          this.pushEvent(task, { kind: 'raw', text: line.slice(0, 500) });
          continue;
        }
        for (const ev of ad.parse(obj)) {
          if (ev.kind === 'session') {
            if (ev.id && task.sessionId !== ev.id) {
              task.sessionId = ev.id;
              this.touch(task);
            }
            continue;
          }
          if (ev.kind === 'text') lastText = ev.text;
          if (ev.kind === 'result') {
            gotResult = ev;
            if (!ev.text) ev.text = lastText;
          }
          this.pushEvent(task, ev);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (e) => {
      this.procs.delete(task.id);
      const hint = e.code === 'ENOENT' ? ` — '${ad.bin()}' 명령을 찾을 수 없습니다. CLI 설치/PATH를 확인하세요.` : '';
      this.finish(task, false, `실행 오류: ${e.message}${hint}`);
    });
    child.on('close', (code, signal) => {
      if (!this.procs.has(task.id)) return; // error 핸들러에서 처리됨
      this.procs.delete(task.id);
      if (task.status === 'stopped') return this.pump();
      const ok = gotResult ? gotResult.ok && code === 0 : code === 0;
      if (gotResult) {
        task.finalText = gotResult.text || lastText;
        task.meta = gotResult.meta || null;
      } else task.finalText = lastText;
      const err = ok ? null : (stderr.trim() || `종료 코드 ${code}${signal ? ` (${signal})` : ''}`);
      this.finish(task, ok, err);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(turn.prompt);
  }

  finish(task, ok, errText) {
    const turn = task.turns[task.turns.length - 1];
    if (turn) {
      turn.status = ok ? 'done' : 'failed';
      turn.endedAt = Date.now();
    }
    if (errText) this.pushEvent(task, { kind: 'error', text: errText.slice(-2000) });
    task.status = ok ? 'done' : 'failed';
    this.touch(task);
    this.save(task, true);
    this.pump();
  }

  stop(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('작업 없음');
    const child = this.procs.get(id);
    if (task.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
    } else if (!child) throw new Error('실행 중이 아닙니다');
    task.status = 'stopped';
    const turn = task.turns[task.turns.length - 1];
    if (turn) {
      turn.status = 'stopped';
      turn.endedAt = Date.now();
    }
    this.pushEvent(task, { kind: 'error', text: '사용자가 중지함' });
    if (child) {
      if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      else child.kill('SIGTERM');
    }
    this.touch(task);
    this.save(task, true);
    this.pump();
    return task;
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.procs.has(id)) throw new Error('실행 중인 작업은 먼저 중지하세요');
    this.tasks.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    this.emit('removed', { id });
  }
}
