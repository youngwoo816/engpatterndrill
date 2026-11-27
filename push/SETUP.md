# 서버 설정 (학습 알림 · 자동 백업 · 관리자) — Cloudflare Workers 무료 플랜

`push/worker.js` 하나를 Cloudflare에 올리면 학습 알림(푸시), 학습 기록 자동 백업, 관리자 페이지가 모두 동작합니다.
약 15분, 비용 0원(카드 등록 불필요). 현재 운영 중인 워커 이름: `rep-english`

> 코드를 업데이트할 때는 **3단계의 3번(코드 붙여넣기 → 배포)** 만 다시 하면 됩니다. KV·크론·비밀 설정은 그대로 유지됩니다.

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
3. **Variables and Secrets → Add** (비밀 Secret) — 관리자 페이지용
   - `ADMIN_KEY` = 나만 아는 긴 문자열 (`admin/SETUP.md` 참고)
4. (선택) **Variables and Secrets → Add**
   - `ALLOW_ORIGIN` = `https://youngwoo816.github.io` (이 사이트에서만 호출 허용)

## 5. 동작 확인
1. 워커 주소(예: `https://rep-english.youngwoo816.workers.dev`)를 브라우저로 열기
   → `{"ok":true,"service":"rep-english","version":2}` 가 보이면 정상
2. 주소 뒤에 `/vapid` 를 붙여 열기 → `{"publicKey":"B..."}` 가 보이면 정상 (첫 호출 때 키가 자동 생성됨)

## 6. 앱에 연결
`config.js` 의 `serverUrl` 에 워커 주소를 넣고 배포 (또는 주소만 알려 주면 반영해 드립니다)
```js
window.REP_CONFIG = { serverUrl: "https://rep-english.youngwoo816.workers.dev" };
```

## 7. 사용자 쪽 켜는 방법
- 앱 → 설정 → **학습 알림** → 시간·요일 선택 → 푸시 알림 **켜기** → 알림 허용 (밤 10시 알림은 선택)
- **Android·PC (Chrome·Edge·Firefox)**: 브라우저에서 바로 사용 가능
- **iPhone·iPad**: iOS 16.4 이상, Safari 공유 버튼 → **홈 화면에 추가** 한 앱에서 열어야 켤 수 있음 (Apple 정책)

## 동작 방식과 한도
- 5분마다 실행되어 그 시각(5분 단위)에 해당하는 사용자에게만 발송, 그날 Day를 마친 사용자는 건너뜀
- 알림 문구: 자동 백업된 기록으로 "연속 5일째 · 복습 12문장" 같은 맞춤 문구를 만들어 암호화해 보냄
- 밤 10시 알림(사용자 선택): 그날 학습 기록이 없고 연속 학습일이 있으면 한 번 더 알림
- 자동 백업: 학습자 기기에서 최대 10분에 한 번, Day 완료 시 즉시 저장 → KV 쓰기 1천/일 기준 하루 활동 학습자 약 100명까지 여유
- 알림 시간은 각 사용자의 기기 시간대 기준
- 무료 플랜 한도(2026년 기준 공식 문서 확인 권장): 요청 10만/일, KV 쓰기 1천/일, KV 목록 1천/일
  - 크론 5분 = 목록 288회/일 → 여유 있음
  - KV 쓰기는 자동 백업(위)과 알림 설정 변경 때 발생
- 서버에 저장되는 것: 푸시 주소·암호화 키(브라우저가 발급), 알림 시간·요일·시간대, 학습 기록 백업(복구 코드로만 열람), 공유에 동의한 학습자의 닉네임과 진도 요약. 이메일·전화번호 등은 저장하지 않음
- 만료된 구독(앱 삭제, 알림 차단)은 발송 시 자동 삭제
