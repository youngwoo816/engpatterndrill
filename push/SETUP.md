# 학습 알림(푸시) 서버 설정 — Cloudflare Workers 무료 플랜

앱이 꺼져 있어도 정해진 시간에 푸시 알림을 보내려면 알림 서버가 필요합니다.
`push/worker.js` 하나를 Cloudflare에 올리면 됩니다. 약 15분, 비용 0원(카드 등록 불필요).

> 설정하지 않아도 앱의 **캘린더 알림**(구글 캘린더 / .ics)은 그대로 동작합니다.

## 1. 계정 만들기
1. https://dash.cloudflare.com/sign-up 에서 이메일로 가입 → 이메일 인증

## 2. 저장소(KV) 만들기
1. 왼쪽 메뉴 **Storage & Databases → Workers KV** (또는 **KV**)
2. **Create** (Create namespace) → 이름 `rep-english-push` → 만들기

## 3. 워커 만들기
1. 왼쪽 메뉴 **Compute (Workers) → Workers & Pages → Create**
2. **Start with Hello World** (Create Worker) → 이름 `rep-english-push` → **Deploy**
3. **Edit code** → 기존 코드를 모두 지우고 `push/worker.js` 내용 전체를 붙여 넣기 → **Deploy**

## 4. 워커 설정 (워커 화면 → Settings)
1. **Bindings → Add → KV namespace**
   - Variable name: `SUBS` (정확히 대문자)
   - KV namespace: `rep-english-push` → Save
2. **Trigger Events (Triggers) → Add → Cron Triggers**
   - 식: `*/5 * * * *` (5분마다) → Add / Save
3. (선택) **Variables and Secrets → Add**
   - `ALLOW_ORIGIN` = `https://youngwoo816.github.io` (이 사이트에서만 호출 허용)

## 5. 동작 확인
1. 워커 주소(예: `https://rep-english-push.계정이름.workers.dev`)를 브라우저로 열기
   → `{"ok":true,"service":"rep-english-push"}` 가 보이면 정상
2. 주소 뒤에 `/vapid` 를 붙여 열기 → `{"publicKey":"B..."}` 가 보이면 정상 (첫 호출 때 키가 자동 생성됨)

## 6. 앱에 연결
`config.js` 의 `pushUrl` 에 워커 주소를 넣고 배포 (또는 주소만 알려 주면 반영해 드립니다)
```js
window.REP_CONFIG = { syncUrl: "", pushUrl: "https://rep-english-push.계정이름.workers.dev" };
```

## 7. 사용자 쪽 켜는 방법
- 앱 → 설정 → **학습 알림** → 시간·요일 선택 → 푸시 알림 **켜기** → 알림 허용 → **알림 테스트**
- **Android·PC (Chrome·Edge·Firefox)**: 브라우저에서 바로 사용 가능
- **iPhone·iPad**: iOS 16.4 이상, Safari 공유 버튼 → **홈 화면에 추가** 한 앱에서 열어야 켤 수 있음 (Apple 정책)

## 동작 방식과 한도
- 5분마다 실행되어 그 시각(5분 단위)에 해당하는 사용자에게만 발송, 그날 Day를 마친 사용자는 건너뜀
- 알림 시간은 각 사용자의 기기 시간대 기준
- 무료 플랜 한도(2026년 기준 공식 문서 확인 권장): 요청 10만/일, KV 쓰기 1천/일, KV 목록 1천/일
  - 크론 5분 = 목록 288회/일 → 여유 있음
  - KV 쓰기는 알림 설정 변경·Day 완료 때만 발생 → 사용자 수백 명까지 무리 없음
- 서버에 저장되는 것: 푸시 주소(브라우저가 발급한 무작위 주소), 알림 시간·요일·시간대, 마지막 완료 날짜. 이름·이메일 등 개인정보는 저장하지 않음
- 만료된 구독(앱 삭제, 알림 차단)은 발송 시 자동 삭제
