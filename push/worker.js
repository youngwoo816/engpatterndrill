/*
 * Rep English 서버 (Cloudflare Workers 무료 플랜용) — 학습 알림 + 자동 백업 + 관리자 조회
 *
 * [학습 알림]  앱이 보낸 알림 시간/요일/시간대를 KV에 저장하고, 5분마다(크론) 시간이 된 사용자에게 웹 푸시 발송
 *   - 백업과 연결된 사용자에게는 "복습 12문장 · 연속 5일째" 같은 맞춤 문구를 암호화해서 보냄 (RFC 8291)
 *   - 밤 10시 알림(선택): 오늘 학습 기록이 없고 연속 학습일이 끊기기 직전이면 한 번 더 알림
 * [자동 백업]  앱이 학습 기록 전체를 저장(/sync)하고, 복구 코드로 다른 기기에서 불러옴(/restore)
 * [관리자]     /admin?key=관리자키 → "선생님께 진도 보내기"에 동의한 학습자 목록 (admin.html이 사용)
 *
 * 필요한 설정
 *   - KV 바인딩 이름: SUBS
 *   - 크론 트리거: "*\/5 * * * *"
 *   - 비밀(Secret) ADMIN_KEY: 관리자 페이지 비밀번호 (관리자 페이지를 쓸 때만)
 * 선택 설정(변수): SUBJECT = 앱 주소(https://...) 또는 mailto:주소, ALLOW_ORIGIN = 앱 주소(기본 *)
 * VAPID 키는 첫 실행 때 자동으로 만들어 KV에 보관 (직접 만들거나 붙여 넣을 필요 없음)
 */
const SLOT = 5;              // 크론 주기(분)와 같아야 함
const LATE = "22:00";        // 연속 기록 지키기 알림 시각
const MAX_BODY = 600000;     // 백업 최대 크기(바이트)

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": (env.ALLOW_ORIGIN || "*").trim().replace(/\/+$/, ""),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (!env.SUBS) return json({ error: "KV 바인딩(SUBS)이 없어요. 워커 설정 → 바인딩에서 변수 이름 SUBS로 KV를 연결하세요" }, 500);
      if (req.method === "GET" && path === "/") return json({ ok: true, service: "rep-english", version: 2 });
      if (req.method === "GET" && path === "/vapid") return json({ publicKey: (await vapid(env)).pub });
      if (req.method === "GET" && path === "/admin") return json(await admin(env, url.searchParams));
      if (req.method !== "POST") return json({ error: "not found" }, 404);

      const text = await req.text();
      if (text.length > MAX_BODY) return json({ error: "too large" }, 413);
      let b = {}; try { b = JSON.parse(text); } catch (_) {}

      // ---------- 자동 백업 ----------
      if (path === "/sync") {
        if (!validId(b.id) || !validToken(b.token)) return json({ error: "bad id" }, 400);
        const key = "u:" + b.id;
        const old = await env.SUBS.get(key, "json");
        if (old && old.token !== b.token) return json({ error: "token mismatch" }, 403);
        await env.SUBS.put(key, JSON.stringify({
          token: b.token, name: String(b.name || "").slice(0, 40), share: !!b.share,
          updatedAt: new Date().toISOString(), summary: b.summary || null, backup: b.backup || (old && old.backup) || null,
        }));
        return json({ ok: true });
      }
      if (path === "/restore") {
        const m = String(b.code || "").trim().match(/^([a-zA-Z0-9-]{8,64})\.([a-zA-Z0-9_-]{16,64})$/);
        if (!m) return json({ error: "bad code" }, 400);
        const rec = await env.SUBS.get("u:" + m[1], "json");
        if (!rec || rec.token !== m[2] || !rec.backup) return json({ error: "not found" }, 404);
        return json({ ok: true, backup: rec.backup, updatedAt: rec.updatedAt });
      }

      // ---------- 학습 알림 ----------
      if (!validEndpoint(b.endpoint)) return json({ error: "bad endpoint" }, 400);
      const key = "s:" + await sha(b.endpoint);
      if (path === "/subscribe") {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || "")) return json({ error: "bad time" }, 400);
        const days = [...new Set((b.days || []).map(Number).filter(d => d >= 0 && d <= 6))].sort().join("");
        if (!days) return json({ error: "no days" }, 400);
        const tz = validTz(b.tz) ? b.tz : "Asia/Seoul";
        const old = await env.SUBS.getWithMetadata(key);
        const k = b.keys && /^[A-Za-z0-9_-]{80,100}$/.test(b.keys.p256dh || "") && /^[A-Za-z0-9_-]{16,32}$/.test(b.keys.auth || "")
          ? { p: b.keys.p256dh, a: b.keys.auth } : undefined;
        const meta = { e: b.endpoint, t: b.time, d: days, z: tz, done: (old.metadata && old.metadata.done) || "",
          u: validId(b.id) ? b.id : "", l: b.late ? 1 : 0, k };
        await env.SUBS.put(key, "1", { metadata: meta });
        return json({ ok: true });
      }
      if (path === "/unsubscribe") { await env.SUBS.delete(key); return json({ ok: true }); }
      if (path === "/done") {
        const old = await env.SUBS.getWithMetadata(key);
        if (old.metadata && /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") && old.metadata.done !== b.date)
          await env.SUBS.put(key, "1", { metadata: { ...old.metadata, done: b.date } });
        return json({ ok: true });
      }
      if (path === "/test") {
        const old = await env.SUBS.getWithMetadata(key);
        const m = old.metadata || { e: b.endpoint };
        const L = localParts(new Date(), m.z || "Asia/Seoul");
        const msg = await message(env, m, L, false);
        const r = await push(env, m, msg, new Map());
        return json({ ok: r.ok, status: r.status, msg }, r.ok ? 200 : 502);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env, new Date(event.scheduledTime || Date.now())));
  },
};

// ---------- 관리자 ----------
async function admin(env, q) {
  const key = env.ADMIN_KEY || "";
  if (!key || !safeEq(q.get("key") || "", key)) return { ok: false, error: "unauthorized" };
  if (q.get("action") === "delete" && validId(q.get("id"))) {
    const rec = await env.SUBS.get("u:" + q.get("id"), "json");
    if (rec) { rec.share = false; await env.SUBS.put("u:" + q.get("id"), JSON.stringify(rec)); }
    return { ok: true, deleted: !!rec };
  }
  const rows = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: "u:", cursor });
    const recs = await Promise.all(page.keys.map(k => env.SUBS.get(k.name, "json")));
    recs.forEach((r, i) => {
      if (!r || !r.share || !r.summary) return;
      rows.push({ ...r.summary, id: page.keys[i].name.slice(2), name: r.name, updatedAt: r.updatedAt });
    });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { ok: true, rows };
}

// ---------- 알림 발송 ----------
async function runDue(env, now) {
  const jwtCache = new Map();
  let cursor, sent = 0, removed = 0;
  const [lh, lm] = LATE.split(":").map(Number);
  do {
    const page = await env.SUBS.list({ prefix: "s:", cursor });
    for (const k of page.keys) {
      const m = k.metadata; if (!m || !m.e) continue;
      const L = localParts(now, m.z);
      if (!m.d.includes(String(L.wd))) continue;
      if (m.done === L.date) continue;                      // 오늘 Day 완료 → 건너뜀
      const inSlot = (h, mi) => h === L.h && Math.floor(mi / SLOT) === Math.floor(L.m / SLOT);
      const [h, mi] = m.t.split(":").map(Number);
      let late = false;
      if (!inSlot(h, mi)) {
        // 밤 10시 알림: 켜 둔 사람만, 기본 알림 시각이 그보다 이를 때만
        if (!(m.l && inSlot(lh, lm) && h * 60 + mi < lh * 60 + lm)) continue;
        late = true;
      }
      const msg = await message(env, m, L, late);
      if (!msg) continue;                                    // 늦은 알림인데 끊길 기록이 없음
      const r = await push(env, m, msg, jwtCache);
      if (r.status === 404 || r.status === 410) { await env.SUBS.delete(k.name); removed++; }
      else if (r.ok) sent++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, removed };
}

// 백업된 학습 기록으로 맞춤 문구 만들기. 기록이 없으면 기본 문구
async function message(env, m, L, late) {
  let st = null;
  if (m.u) { const rec = await env.SUBS.get("u:" + m.u, "json"); st = rec && rec.backup; }
  const base = { title: "Rep English", body: "오늘의 영어 문장 연습할 시간이에요. 10분이면 충분해요!" };
  if (!st || typeof st !== "object") return late ? null : base;
  const s = stats(st, L.date);
  if (late) {
    if (s.studiedToday || s.streak < 1) return null;
    return { title: `연속 ${s.streak}일 기록이 끊기기 직전이에요`, body: s.due ? `복습 ${s.due}문장만 해도 기록이 이어져요.` : "오늘 분량을 마치면 기록이 이어져요." };
  }
  if (s.streak > 0 && s.due > 0) return { title: `연속 ${s.streak}일째 🔥`, body: `복습 ${s.due}문장과 오늘의 새 문장이 기다려요.` };
  if (s.due > 0) return { title: "복습할 시간이에요", body: `복습할 문장 ${s.due}개가 있어요. 10분이면 끝나요.` };
  if (s.streak > 0) return { title: `연속 ${s.streak}일째 🔥`, body: "오늘도 이어가 볼까요? 새 문장이 기다려요." };
  return base;
}

// 앱의 streak()·dueList()와 같은 규칙
function stats(st, today) {
  const days = new Set([...(st.sessions || []).map(x => x && x.date), ...Object.keys(st.revDone || {})]);
  const prev = d => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
  let d = today; if (!days.has(d)) d = prev(d);
  let streak = 0; while (days.has(d)) { streak++; d = prev(d); }
  const cap = Number(st.settings && st.settings.reviewMax) || 20;
  const due = Math.min(cap, Object.values(st.learned || {}).filter(x => x && x.due && x.due <= today).length);
  const studiedToday = days.has(today) || ((st.activity || {})[today] || 0) > 0;
  return { streak, due, studiedToday };
}

function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(date).map(x => [x.type, x.value]));
  return {
    h: Number(p.hour) % 24, m: Number(p.minute),
    wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

async function push(env, m, msg, jwtCache) {
  const endpoint = m.e;
  const aud = new URL(endpoint).origin;
  let auth = jwtCache.get(aud);
  if (!auth) {
    const v = await vapid(env);
    const jwt = await signJwt(v.priv, { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.SUBJECT || "https://youngwoo816.github.io/engpatterndrill/" });
    auth = `vapid t=${jwt}, k=${v.pub}`;
    jwtCache.set(aud, auth);
  }
  const headers = { Authorization: auth, TTL: "3600", Urgency: "normal" };
  let body = null;
  if (m.k && msg) {
    body = await encrypt(JSON.stringify(msg), m.k.p, m.k.a);
    headers["Content-Encoding"] = "aes128gcm";
    headers["Content-Type"] = "application/octet-stream";
  } else headers["Content-Length"] = "0";
  return fetch(endpoint, { method: "POST", headers, body });
}

// ---------- 웹 푸시 본문 암호화 (RFC 8291, aes128gcm) ----------
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const utf8 = s => new TextEncoder().encode(s);
async function encrypt(text, p256dh, authSecret) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, cat(utf8("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(utf8("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(utf8("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(utf8(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function vapid(env) {
  if (vapid.c) return vapid.c;
  let s = await env.SUBS.get("vapid", "json");
  if (!s) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    s = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.SUBS.put("vapid", JSON.stringify(s));
  }
  const priv = await crypto.subtle.importKey("jwk", s.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return (vapid.c = { priv, pub: s.pub });
}

async function signJwt(key, claims) {
  const enc = o => b64u(utf8(JSON.stringify(o)));
  const data = `${enc({ typ: "JWT", alg: "ES256" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(data));
  return `${data}.${b64u(sig)}`;
}

function b64u(buf) {
  const a = new Uint8Array(buf); let s = "";
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function sha(t) { return b64u(await crypto.subtle.digest("SHA-256", utf8(t))).slice(0, 32); }
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function validId(id) { return typeof id === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(id); }
function validToken(t) { return typeof t === "string" && /^[a-zA-Z0-9_-]{16,64}$/.test(t); }
function validTz(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length < 64; } catch (e) { return false; } }
// 알려진 브라우저 푸시 서비스 주소만 허용 (임의 주소로 요청을 보내는 데 악용되지 않게)
function validEndpoint(e) {
  try {
    const u = new URL(e);
    return u.protocol === "https:" && e.length < 600 &&
      /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/.test(u.hostname);
  } catch (_) { return false; }
}
