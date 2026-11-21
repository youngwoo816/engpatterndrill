/**
 * Rep English 학습 기록 수집용 Google Apps Script
 * - 학습 앱(POST)이 학습자별 진도 요약을 보내면 'learners' 시트에 한 줄씩 저장/갱신합니다.
 * - 관리자 페이지(GET)는 관리자 키가 맞을 때만 전체 목록을 받습니다.
 * 설정: 프로젝트 설정 → 스크립트 속성 → ADMIN_KEY 에 나만 아는 긴 문자열을 넣으세요.
 */
const SHEET_NAME = 'learners';
const HEAD = ['learnerId', 'name', 'updatedAt', 'lastStudy', 'learned', 'mastered', 'streak',
  'daysDone', 'reviewDue', 'exRead', 'daily', 'travel', 'business', 'todayNew', 'summaryJson'];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEAD); sh.setFrozenRows(1); }
  return sh;
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function rowIndex_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}
function catText_(c) { return c ? `${c.learned}/${c.total} (Day ${c.days})` : ''; }

/** 학습 앱 → 진도 요약 저장 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const d = JSON.parse(e.postData.contents);
    if (!d || typeof d.id !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(d.id)) return out_({ ok: false, error: 'bad id' });
    lock.waitLock(10000);
    const sh = sheet_();
    let row = rowIndex_(sh, d.id);
    if (row < 0) row = sh.getLastRow() + 1;
    const cats = d.cats || {};
    const values = [d.id, String(d.name || '').slice(0, 40), new Date(), String(d.lastStudy || ''),
      +d.learned || 0, +d.mastered || 0, +d.streak || 0, +d.daysDone || 0, +d.reviewDue || 0, +d.exRead || 0,
      catText_(cats.daily), catText_(cats.travel), catText_(cats.business), +d.todayNew || 0,
      JSON.stringify(d).slice(0, 45000)];
    sh.getRange(row, 1, 1, HEAD.length).setValues([values]);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/** 관리자 페이지 → 목록 조회 / 학습자 삭제 (관리자 키 필요) */
function doGet(e) {
  const key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  const p = (e && e.parameter) || {};
  if (!key || p.key !== key) return out_({ ok: false, error: 'unauthorized' });
  const sh = sheet_();
  if (p.action === 'delete' && p.id) {
    const row = rowIndex_(sh, p.id);
    if (row > 0) sh.deleteRow(row);
    return out_({ ok: true, deleted: row > 0 });
  }
  const last = sh.getLastRow();
  if (last < 2) return out_({ ok: true, rows: [] });
  const vals = sh.getRange(2, 1, last - 1, HEAD.length).getValues();
  const rows = vals.map(r => {
    let s = {};
    try { s = JSON.parse(r[HEAD.length - 1]); } catch (_) {}
    s.id = r[0]; s.name = r[1]; s.updatedAt = r[2] instanceof Date ? r[2].toISOString() : String(r[2]);
    return s;
  });
  return out_({ ok: true, rows });
}
