/*
 * Rep English 학습 알림 서버 (Cloudflare Workers 무료 플랜용)
 * - 앱이 보낸 알림 시간/요일/시간대를 KV에 저장
 * - 5분마다(크론) 시간이 된 사용자에게 웹 푸시를 보냄
 * - 내용 없는 푸시(빈 본문)만 보내므로 암호화 라이브러리가 필요 없음. 알림 문구는 앱의 sw.js가 정함
 * - VAPID 키는 첫 실행 때 자동으로 만들어 KV에 보관 (직접 만들거나 붙여 넣을 필요 없음)
 * 필요한 설정: KV 바인딩 이름 SUBS, 크론 트리거 "*\/5 * * * *"
 * 선택 설정(변수): SUBJECT = 앱 주소(https://...) 또는 mailto:주소, ALLOW_ORIGIN = 앱 주소(기본 *)
 */
const SLOT = 5; // 크론 주기(분)와 같아야 함

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && path === "/vapid") return json({ publicKey: (await vapid(env)).pub });
      if (req.method === "GET" && path === "/") return json({ ok: true, service: "rep-english-push" });
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      const b = await req.json().catch(() => ({}));
      if (!validEndpoint(b.endpoint)) return json({ error: "bad endpoint" }, 400);
      const key = "s:" + await sha(b.endpoint);
      if (path === "/subscribe") {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || "")) return json({ error: "bad time" }, 400);
        const days = [...new Set((b.days || []).map(Number).filter(d => d >= 0 && d <= 6))].sort().join("");
        if (!days) return json({ error: "no days" }, 400);
        const tz = validTz(b.tz) ? b.tz : "Asia/Seoul";
        const old = await env.SUBS.getWithMetadata(key);
        await env.SUBS.put(key, "1", { metadata: { e: b.endpoint, t: b.time, d: days, z: tz, done: (old.metadata && old.metadata.done) || "" } });
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
        const r = await push(env, b.endpoint, new Map());
        return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502);
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

// 시간이 된 구독자에게 발송. 목록의 메타데이터만 읽으므로 KV 읽기 횟수를 거의 쓰지 않음
export async function runDue(env, now) {
  const jwtCache = new Map();
  let cursor, sent = 0, removed = 0;
  do {
    const page = await env.SUBS.list({ prefix: "s:", cursor });
    for (const k of page.keys) {
      const m = k.metadata; if (!m || !m.e) continue;
      const L = localParts(now, m.z);
      const [h, mi] = m.t.split(":").map(Number);
      if (h !== L.h || Math.floor(mi / SLOT) !== Math.floor(L.m / SLOT)) continue;
      if (!m.d.includes(String(L.wd))) continue;
      if (m.done === L.date) continue; // 오늘 이미 학습 완료
      const r = await push(env, m.e, jwtCache);
      if (r.status === 404 || r.status === 410) { await env.SUBS.delete(k.name); removed++; }
      else if (r.ok) sent++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, removed };
}

export function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(date).map(x => [x.type, x.value]));
  return {
    h: Number(p.hour) % 24, m: Number(p.minute),
    wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

async function push(env, endpoint, jwtCache) {
  const aud = new URL(endpoint).origin;
  let auth = jwtCache.get(aud);
  if (!auth) {
    const v = await vapid(env);
    const jwt = await signJwt(v.priv, { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.SUBJECT || "https://youngwoo816.github.io/engpatterndrill/" });
    auth = `vapid t=${jwt}, k=${v.pub}`;
    jwtCache.set(aud, auth);
  }
  return fetch(endpoint, { method: "POST", headers: { Authorization: auth, TTL: "3600", Urgency: "normal", "Content-Length": "0" } });
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
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${enc({ typ: "JWT", alg: "ES256" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(data));
  return `${data}.${b64u(sig)}`;
}

function b64u(buf) {
  const a = new Uint8Array(buf); let s = "";
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha(t) { return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))).slice(0, 32); }
function validTz(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length < 64; } catch (e) { return false; } }
// 알려진 브라우저 푸시 서비스 주소만 허용 (임의 주소로 요청을 보내는 데 악용되지 않게)
function validEndpoint(e) {
  try {
    const u = new URL(e);
    return u.protocol === "https:" && e.length < 800 &&
      /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/.test(u.hostname);
  } catch (_) { return false; }
}
