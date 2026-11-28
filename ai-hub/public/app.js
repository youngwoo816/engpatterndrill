// AI Hub 프론트엔드 (빌드 없음, 순수 JS)
const $ = (s) => document.querySelector(s);
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };
const STATUS = { idle: '대기', queued: '대기열', running: '진행 중', done: '완료', failed: '실패', stopped: '중지' };

// 토큰: ?token=… 으로 한 번 열면 저장
let token = '';
try {
  const q = new URLSearchParams(location.search).get('token');
  if (q) localStorage.setItem('hub-token', q);
  token = q || localStorage.getItem('hub-token') || '';
} catch {}

const state = {
  tab: (() => { try { return localStorage.getItem('hub-tab') || 'claude'; } catch { return 'claude'; } })(),
  tasks: new Map(), // id -> summary
  current: null, // full task
  sub: 'log',
  modes: {},
  health: {},
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-hub-token': token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtClock = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortPath = (p) => (p || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');

// ---------------- 탭 ----------------
function setTab(tab) {
  state.tab = tab;
  try { localStorage.setItem('hub-tab', tab); } catch {}
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderList();
  loadLocal();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});

// ---------------- 목록 ----------------
function matchFilter(t) {
  const f = $('#filter-status').value;
  if (!f) return true;
  if (f === 'active') return t.status === 'running' || t.status === 'queued';
  if (f === 'failed') return t.status === 'failed' || t.status === 'stopped';
  return t.status === f;
}
$('#filter-status').addEventListener('change', renderList);

function renderList() {
  const list = [...state.tasks.values()]
    .filter((t) => state.tab === 'all' || t.agent === state.tab)
    .filter(matchFilter)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const el = $('#task-list');
  if (!list.length) {
    el.innerHTML = `<p class="muted small">아직 작업이 없습니다.</p>`;
    return;
  }
  el.innerHTML = list
    .map(
      (t) => `<button class="item ${state.current?.id === t.id ? 'active' : ''}" data-id="${t.id}">
        <div class="t">${esc(t.title)}</div>
        <div class="s"><span class="badge ${t.status}">${STATUS[t.status] || t.status}</span>
        ${state.tab === 'all' ? `<span class="ag ${t.agent}">${AGENT_NAME[t.agent]}</span>` : ''}
        <span>${esc(shortPath(t.cwd))}</span><span>· ${fmtTime(t.updatedAt)}</span></div>
      </button>`
    )
    .join('');
  updateCwdList();
}
$('#task-list').addEventListener('click', (e) => {
  const b = e.target.closest('.item');
  if (b) openTask(b.dataset.id);
});

function updateCwdList() {
  const set = new Set([...state.tasks.values()].map((t) => t.cwd).filter(Boolean));
  $('#cwd-list').innerHTML = [...set].map((c) => `<option value="${esc(c)}"></option>`).join('');
}

// ---------------- 기존 로컬 세션 ----------------
let localSessions = [];
async function loadLocal() {
  const el = $('#local-list');
  try {
    const agent = state.tab === 'all' ? '' : state.tab;
    localSessions = await api(`/api/sessions${agent ? `?agent=${agent}` : ''}`);
    const known = new Set([...state.tasks.values()].map((t) => t.sessionId));
    const rows = localSessions.filter((s) => !known.has(s.sessionId)).slice(0, 30);
    el.innerHTML = rows.length
      ? rows
          .map(
            (s, i) => `<button class="item" data-i="${localSessions.indexOf(s)}" title="${esc(s.cwd)}">
          <div class="t">${esc(s.title || '(첫 메시지 없음)')}</div>
          <div class="s"><span class="ag ${s.agent}">${AGENT_NAME[s.agent]}</span><span>${esc(shortPath(s.cwd))}</span><span>· ${fmtTime(s.updatedAt)}</span></div>
        </button>`
          )
          .join('')
      : `<p class="muted small">표시할 세션이 없습니다.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="error small">${esc(e.message)}</p>`;
  }
}
$('#local-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.item');
  if (!b) return;
  const s = localSessions[Number(b.dataset.i)];
  if (!s.cwd) return alert('이 세션의 작업 폴더 정보를 찾지 못했습니다.');
  // 프롬프트 없이 세션만 가져오기 → 이후 '이어서 지시하기'로 계속
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { agent: s.agent, cwd: s.cwd, sessionId: s.sessionId, title: `[가져옴] ${s.title || s.sessionId}` } });
    state.tasks.set(t.id, t);
    renderList();
    openTask(t.id);
    loadLocal();
  } catch (err) {
    alert(err.message);
  }
});

// ---------------- 화면 전환 ----------------
function show(view) {
  for (const v of ['empty', 'new', 'task']) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  document.body.classList.toggle('detail', view !== 'empty');
}
$('#btn-back').addEventListener('click', () => {
  state.current = null;
  show('empty');
  renderList();
});

// ---------------- 새 작업 ----------------
function fillModes() {
  document.querySelectorAll('.mode-select').forEach((sel) => {
    const v = sel.value;
    sel.innerHTML = Object.entries(state.modes).map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
    if (v) sel.value = v;
  });
}
$('#btn-new').addEventListener('click', () => {
  const f = $('#form-new');
  f.agent.value = state.tab === 'all' ? 'claude' : state.tab;
  try { f.cwd.value = f.cwd.value || localStorage.getItem('hub-last-cwd') || ''; } catch {}
  $('#new-error').textContent = '';
  state.current = null;
  renderList();
  show('new');
  f.prompt.focus();
});
$('#btn-cancel-new').addEventListener('click', () => show(state.current ? 'task' : 'empty'));
$('#form-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#form-new').requestSubmit();
});
$('#form-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#new-error').textContent = '';
  if (f.mode.value === 'full' && !confirm('전체 권한은 확인 없이 명령을 실행합니다. 계속할까요?')) return;
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { agent: f.agent.value, cwd: f.cwd.value.trim(), mode: f.mode.value, prompt: f.prompt.value } });
    try { localStorage.setItem('hub-last-cwd', f.cwd.value.trim()); } catch {}
    f.prompt.value = '';
    state.tasks.set(t.id, t);
    openTask(t.id);
  } catch (err) {
    $('#new-error').textContent = err.message;
  }
});

// ---------------- 작업 상세 ----------------
async function openTask(id) {
  try {
    state.current = await api(`/api/tasks/${id}`);
  } catch (e) {
    return alert(e.message);
  }
  show('task');
  renderList();
  renderTask();
  setSub(state.sub);
}

function renderTask() {
  const t = state.current;
  if (!t) return;
  $('#t-title').textContent = t.title;
  $('#t-meta').innerHTML = `
    <span class="ag ${t.agent}">${AGENT_NAME[t.agent]}</span>
    <span class="badge ${t.status}">${STATUS[t.status] || t.status}</span>
    <span title="${esc(t.cwd)}">📁 ${esc(t.cwd)}</span>
    <span>권한: ${esc(state.modes[t.mode] || t.mode)}</span>
    ${t.sessionId ? `<span>세션 <code>${esc(t.sessionId.slice(0, 8))}</code></span>` : ''}
    ${t.meta?.durationMs ? `<span>${Math.round(t.meta.durationMs / 1000)}초</span>` : ''}
    <span>턴 ${t.turns.length}</span>`;
  const active = t.status === 'running' || t.status === 'queued';
  $('#btn-stop').disabled = !active;
  $('#btn-delete').disabled = active;
  $('#form-follow').querySelector('button').disabled = active;
  $('#form-follow').mode.value = t.mode;
  renderLog();
  if (state.sub === 'result') renderResult();
}

function evHtml(e) {
  const cls = e.kind === 'tool_result' && e.error ? 'tool_result err' : e.kind;
  const label = { prompt: '🧑 ', result: e.ok === false ? '❌ ' : '✅ ' }[e.kind] || '';
  let text = e.text || '';
  if (e.kind === 'result') text = e.ok === false ? `실패: ${text}` : '작업 완료';
  return `<div class="ev ${cls}"><span class="time">${fmtClock(e.t)}</span>${label}${esc(text)}</div>`;
}

function renderLog() {
  const pane = $('#pane-log');
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  pane.innerHTML = state.current.events.map(evHtml).join('') || '<p class="muted">아직 로그가 없습니다. 아래에서 지시를 보내세요.</p>';
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
}

function appendEvent(ev) {
  const pane = $('#pane-log');
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  if (state.current.events.length === 1) pane.innerHTML = '';
  pane.insertAdjacentHTML('beforeend', evHtml(ev));
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
}

function renderResult() {
  const t = state.current;
  const pane = $('#pane-result');
  // 턴별 결과: 각 턴의 마지막 text 이벤트
  const byTurn = [];
  for (const e of t.events) if (e.kind === 'text') byTurn[e.turn] = e.text;
  const finals = t.turns.map((turn, i) => ({ prompt: turn.prompt, text: byTurn[i] || '', status: turn.status }));
  if (!finals.length) return (pane.innerHTML = '<p class="muted">결과가 없습니다.</p>');
  pane.innerHTML = finals
    .map(
      (f, i) => `<div style="margin-bottom:16px">
        <div class="result-tools"><span class="muted small grow">턴 ${i + 1} · ${esc(f.prompt.split('\n')[0].slice(0, 80))}</span>
        <button class="btn small" data-copy="${i}">복사</button></div>
        <div class="result-box">${f.text ? esc(f.text) : `<span class="muted">${f.status === 'running' ? '작업 중…' : '텍스트 결과 없음'}</span>`}</div>
      </div>`
    )
    .reverse()
    .join('');
  pane.onclick = (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) navigator.clipboard?.writeText(finals[Number(b.dataset.copy)].text).then(() => (b.textContent = '복사됨'));
  };
}

async function renderDiff() {
  const pane = $('#pane-diff');
  pane.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const d = await api(`/api/tasks/${state.current.id}/diff`);
    if (!d.git) return (pane.innerHTML = `<p class="muted">${esc(d.error)}</p>`);
    const diffHtml = esc(d.diff)
      .split('\n')
      .map((l) => (l.startsWith('+') && !l.startsWith('+++') ? `<span class="add">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="del">${l}</span>` : l.startsWith('@@') ? `<span class="hunk">${l}</span>` : l))
      .join('\n');
    pane.innerHTML = `
      <div class="result-tools"><span class="muted small grow">작업 폴더의 현재 Git 상태 (커밋되지 않은 변경)</span><button class="btn small" id="btn-refresh-diff">새로고침</button></div>
      <h4>변경 파일</h4><pre class="code">${esc(d.status) || '변경 없음'}</pre>
      ${d.diff ? `<h4>diff${d.truncated ? ' (일부만 표시)' : ''}</h4><pre class="code">${diffHtml}</pre>` : ''}`;
    $('#btn-refresh-diff').onclick = renderDiff;
  } catch (e) {
    pane.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function setSub(sub) {
  state.sub = sub;
  document.querySelectorAll('#subtabs button').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  for (const s of ['log', 'result', 'diff']) $(`#pane-${s}`).classList.toggle('hidden', s !== sub);
  if (sub === 'result') renderResult();
  if (sub === 'diff') renderDiff();
  if (sub === 'log') $('#pane-log').scrollTop = $('#pane-log').scrollHeight;
}
$('#subtabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setSub(b.dataset.sub);
});

$('#btn-stop').addEventListener('click', async () => {
  try {
    await api(`/api/tasks/${state.current.id}/stop`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
});
$('#btn-delete').addEventListener('click', async () => {
  if (!confirm('이 작업 기록을 허브에서 삭제할까요? (AI 쪽 세션 파일은 남습니다)')) return;
  try {
    await api(`/api/tasks/${state.current.id}`, { method: 'DELETE' });
  } catch (e) {
    alert(e.message);
  }
});

$('#form-follow').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#form-follow').requestSubmit();
});
$('#form-follow').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#follow-error').textContent = '';
  if (!f.prompt.value.trim()) return;
  if (f.mode.value === 'full' && !confirm('전체 권한은 확인 없이 명령을 실행합니다. 계속할까요?')) return;
  try {
    await api(`/api/tasks/${state.current.id}/followup`, { method: 'POST', body: { prompt: f.prompt.value, mode: f.mode.value } });
    f.prompt.value = '';
    setSub('log');
  } catch (err) {
    $('#follow-error').textContent = err.message;
  }
});

// ---------------- 실시간 (SSE) ----------------
function connect() {
  const es = new EventSource(`/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  es.onopen = () => {
    $('#conn').classList.add('on');
    $('#conn').textContent = '● 연결됨';
    refreshTasks();
  };
  es.onerror = () => {
    $('#conn').classList.remove('on');
    $('#conn').textContent = '● 연결 끊김';
  };
  es.addEventListener('task', (m) => {
    const t = JSON.parse(m.data);
    state.tasks.set(t.id, t);
    if (state.current?.id === t.id) {
      const events = state.current.events;
      state.current = { ...t, events };
      renderTask();
    }
    renderList();
  });
  es.addEventListener('event', (m) => {
    const { taskId, ev } = JSON.parse(m.data);
    if (state.current?.id === taskId) {
      state.current.events.push(ev);
      appendEvent(ev);
      if (state.sub === 'result' && ev.kind === 'text') renderResult();
    }
  });
  es.addEventListener('removed', (m) => {
    const { id } = JSON.parse(m.data);
    state.tasks.delete(id);
    if (state.current?.id === id) {
      state.current = null;
      show('empty');
    }
    renderList();
  });
}

async function refreshTasks() {
  try {
    const list = await api('/api/tasks');
    state.tasks = new Map(list.map((t) => [t.id, t]));
    renderList();
    if (state.current) openTask(state.current.id);
  } catch {}
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    state.modes = h.modes;
    state.health = h.agents;
    fillModes();
    for (const [id, a] of Object.entries(h.agents)) $(`#h-${id}`).className = `dot ${a.ok ? 'ok' : 'bad'}`;
    $('#health-box').innerHTML = Object.values(h.agents)
      .map((a) => `<div class="h"><b>${a.name}</b> — ${a.ok ? `✅ ${esc(a.version)}` : `❌ 실행 불가: ${esc(a.error || '명령을 찾을 수 없음')}`}</div>`)
      .join('');
  } catch (e) {
    $('#health-box').innerHTML = `<div class="h error">${esc(e.message)}</div>`;
  }
}

// ---------------- 시작 ----------------
setTab(state.tab);
loadHealth();
connect();
