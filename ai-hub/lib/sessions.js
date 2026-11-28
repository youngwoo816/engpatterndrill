// PC에 저장된 기존 세션 파일 수집 (터미널에서 직접 실행한 작업 포함)
// 주의: 세션 파일 형식은 공식 규격이 아니라 CLI 업데이트로 바뀔 수 있음 → 최대한 관대하게 파싱
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HEAD_BYTES = 256 * 1024;

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((c) => c && (c.type === 'text' || c.type === 'input_text'))
      .map((c) => c.text)
      .join('\n');
  return '';
}

const isMeta = (s) => !s || /^\s*</.test(s) || s.startsWith('Caveat:');

function walk(dir, depth, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, acc);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        acc.push({ file: p, mtime: fs.statSync(p).mtimeMs });
      } catch {}
    }
  }
  return acc;
}

function claudeSessions(limit) {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = walk(path.join(base, 'projects'), 1, []).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return files.map(({ file, mtime }) => {
    const id = path.basename(file, '.jsonl');
    let cwd = '';
    let title = '';
    for (const o of parseLines(readHead(file))) {
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!title && o.type === 'user' && !o.isMeta) {
        const t = textOf(o.message?.content);
        if (!isMeta(t)) title = t;
      }
      if (cwd && title) break;
    }
    return { agent: 'claude', sessionId: id, cwd, title: title.split('\n')[0].slice(0, 100), updatedAt: mtime };
  });
}

function codexSessions(limit) {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const files = walk(path.join(base, 'sessions'), 4, []).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return files.map(({ file, mtime }) => {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    let id = m ? m[1] : '';
    let cwd = '';
    let title = '';
    for (const o of parseLines(readHead(file))) {
      const p = o.payload || o;
      if (o.type === 'session_meta' || p.type === 'session_meta') {
        id = p.id || id;
        cwd = p.cwd || cwd;
      }
      if (!title) {
        let t = '';
        if (p.type === 'user_message') t = p.message;
        else if (p.type === 'message' && p.role === 'user') t = textOf(p.content);
        if (t && !isMeta(t)) title = t;
      }
      if (id && cwd && title) break;
    }
    return { agent: 'codex', sessionId: id, cwd, title: (title || '').split('\n')[0].slice(0, 100), updatedAt: mtime };
  });
}

export function listLocalSessions(agent, limit = 40) {
  const res = [];
  if (!agent || agent === 'claude') res.push(...claudeSessions(limit));
  if (!agent || agent === 'codex') res.push(...codexSessions(limit));
  return res.filter((s) => s.sessionId).sort((a, b) => b.updatedAt - a.updatedAt);
}
