// 에이전트 어댑터: CLI 실행 인자 생성 + 출력(JSONL) → 공통 이벤트 변환
// 공통 이벤트 kind: session | status | text | tool | tool_result | result | error

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id);
}

export const MODES = {
  read: '읽기/분석만',
  edit: '파일 수정 허용',
  full: '전체 권한 (위험)',
};

function clip(s, n = 600) {
  if (s == null) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + ` …(+${s.length - n}자)` : s;
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'].find((k) => input[k]);
  return key ? clip(String(input[key]), 200) : clip(input, 200);
}

// ---------------- Claude Code ----------------
const claude = {
  id: 'claude',
  name: 'Claude Code',
  bin: () => process.env.CLAUDE_BIN || 'claude',
  // 프롬프트는 stdin으로 전달 (Windows 셸 인용 문제 / 인젝션 방지)
  buildArgs({ mode, resumeId }) {
    const pm = { read: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' }[mode] || 'plan';
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', pm];
    if (resumeId) args.push('--resume', resumeId);
    return args;
  },
  parse(obj) {
    const out = [];
    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init') {
          if (obj.session_id) out.push({ kind: 'session', id: obj.session_id });
          out.push({ kind: 'status', text: `세션 시작${obj.model ? ` · 모델 ${obj.model}` : ''}` });
        }
        break;
      case 'assistant':
        for (const c of obj.message?.content || []) {
          if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text });
          else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}`.trim() });
        }
        break;
      case 'user':
        for (const c of obj.message?.content || []) {
          if (c.type === 'tool_result') {
            const txt = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : c.content;
            out.push({ kind: 'tool_result', text: clip(txt), error: !!c.is_error });
          }
        }
        break;
      case 'result':
        out.push({
          kind: 'result',
          ok: !obj.is_error && obj.subtype === 'success',
          text: obj.result || (obj.subtype !== 'success' ? `종료: ${obj.subtype}` : ''),
          meta: {
            durationMs: obj.duration_ms,
            turns: obj.num_turns,
            costUsd: obj.total_cost_usd, // 구독 사용 시 참고용 환산치
          },
        });
        if (obj.session_id) out.push({ kind: 'session', id: obj.session_id });
        break;
    }
    return out;
  },
};

// ---------------- Codex ----------------
const codex = {
  id: 'codex',
  name: 'Codex',
  bin: () => process.env.CODEX_BIN || 'codex',
  buildArgs({ mode, resumeId }) {
    const sandbox = { read: 'read-only', edit: 'workspace-write', full: 'danger-full-access' }[mode] || 'read-only';
    const common = ['--json', '--skip-git-repo-check'];
    const perm =
      mode === 'full'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-c', `sandbox_mode=${sandbox}`]; // resume에는 -s 옵션이 없어 config 오버라이드 사용
    if (resumeId) return ['exec', 'resume', ...common, ...perm, resumeId, '-'];
    return ['exec', ...common, ...perm, '-'];
  },
  parse(obj) {
    const out = [];
    const it = obj.item || {};
    switch (obj.type) {
      case 'thread.started':
        if (obj.thread_id) out.push({ kind: 'session', id: obj.thread_id });
        out.push({ kind: 'status', text: '세션 시작' });
        break;
      case 'turn.started':
        out.push({ kind: 'status', text: '작업 중…' });
        break;
      case 'item.started':
        if (it.type === 'command_execution') out.push({ kind: 'tool', text: `$ ${clip(it.command, 300)}` });
        break;
      case 'item.completed':
        if (it.type === 'agent_message' && it.text?.trim()) out.push({ kind: 'text', text: it.text });
        else if (it.type === 'command_execution')
          out.push({
            kind: 'tool_result',
            text: `${clip(it.aggregated_output)}${it.exit_code != null ? `\n(exit ${it.exit_code})` : ''}`,
            error: it.exit_code != null && it.exit_code !== 0,
          });
        else if (it.type === 'file_change')
          out.push({ kind: 'tool', text: `파일 변경: ${(it.changes || []).map((c) => `${c.kind} ${c.path}`).join(', ')}` });
        else if (it.type === 'mcp_tool_call') out.push({ kind: 'tool', text: `MCP ${it.server || ''}.${it.tool || ''}` });
        else if (it.type === 'web_search') out.push({ kind: 'tool', text: `웹 검색: ${it.query || ''}` });
        else if (it.type === 'error') out.push({ kind: 'error', text: it.message || '오류' });
        break;
      case 'turn.completed':
        out.push({ kind: 'result', ok: true, text: '', meta: { usage: obj.usage } });
        break;
      case 'turn.failed':
        out.push({ kind: 'result', ok: false, text: obj.error?.message || '작업 실패' });
        break;
      case 'error':
        // 'Reconnecting... n/5' 같은 일시적 재시도 메시지는 상태로 표시
        out.push({ kind: /^Reconnecting/i.test(obj.message || '') ? 'status' : 'error', text: obj.message || '오류' });
        break;
    }
    return out;
  },
};

export const AGENTS = { claude, codex };
