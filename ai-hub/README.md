# AI Hub — Claude Code와 Codex를 한 화면에서

구독 중인 **Claude Code**와 **Codex**의 작업을 한 웹페이지에서 보고, 지시하고, 결과를 확인하는 **개인용 로컬 앱**입니다.

- API 키를 쓰지 않습니다. 내 PC에 로그인된 공식 CLI(`claude`, `codex`)를 대신 실행합니다.
- 외부 패키지가 없습니다. Node.js만 있으면 됩니다.
- 서버는 기본적으로 내 PC(127.0.0.1)에서만 접속됩니다.

## 기능 (1~3단계)

| 기능 | 설명 |
|---|---|
| 탭 | Claude Code / Codex / 전체 |
| 새 작업 | 작업 폴더, 프롬프트, 권한 수준을 지정해 실행 |
| 실시간 로그 | 프롬프트, 도구 사용, 명령 실행, 응답이 실시간으로 표시됨 |
| 결과 | 턴별 최종 답변과 복사 버튼 |
| 변경 파일 | 작업 폴더의 `git status`와 `git diff` |
| 이어서 지시 | 같은 세션으로 후속 프롬프트 전송 |
| 중지 / 삭제 | 실행 중인 작업 중지, 허브 기록 삭제 |
| PC의 기존 세션 | 터미널에서 실행한 세션을 목록에 보여주고, 가져와서 이어서 지시 |
| 대기열 | AI별 동시 실행 수 제한 (기본 1개) |

## 권한 수준

| 화면 표시 | Claude Code | Codex |
|---|---|---|
| 읽기/분석만 (기본값) | `--permission-mode plan` | `sandbox_mode=read-only` |
| 파일 수정 허용 | `--permission-mode acceptEdits` | `sandbox_mode=workspace-write` |
| 전체 권한 (위험) | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

비대화형 실행에서는 중간에 "허용할까요?"를 물을 수 없습니다. 그래서 작업마다 권한을 미리 정합니다.

## 설치 및 실행

### 1. 준비 (한 번만)
1. **Node.js 18 이상**을 설치합니다. (https://nodejs.org)
2. **Claude Code**를 설치하고, 터미널에서 `claude`를 한 번 실행해 구독 계정으로 로그인합니다.
3. **Codex CLI**를 설치하고(`npm i -g @openai/codex`), `codex`를 한 번 실행해 ChatGPT 계정으로 로그인합니다.

### 2. 0단계 검증
```bash
cd ai-hub
npm run verify:quick   # 설치와 버전만 확인 (사용량 소모 없음)
npm run verify         # 짧은 실제 요청 2회씩 실행 → 비대화형 실행, JSON, 세션 이어가기 확인
```
모든 항목이 ✅이면 다음 단계로 진행합니다.

### 3. 실행
```bash
npm start
```
브라우저에서 http://127.0.0.1:4317 을 엽니다.

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `4317` | 포트 |
| `HOST` | `127.0.0.1` | 외부 주소로 열면 `HUB_TOKEN`이 필수 |
| `HUB_TOKEN` | (없음) | 접속 토큰. 처음 한 번 `?token=값`으로 접속하면 브라우저에 저장됨 |
| `MAX_PER_AGENT` | `1` | AI별 동시 실행 수 |
| `ALLOWED_ROOTS` | (제한 없음) | 작업을 허용할 상위 폴더 목록 (구분자: Windows는 `;`, Mac은 `:`) |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | CLI 실행 파일 경로 |
| `HUB_DATA_DIR` | `./data` | 작업 기록 저장 위치 |

Windows PowerShell 예시:
```powershell
$env:ALLOWED_ROOTS="C:\projects"; npm start
```

## 휴대폰에서 접속하기 (선택)

포트를 인터넷에 직접 열지 마세요. **Tailscale**(무료 사설망)을 쓰는 방법을 권장합니다.
1. PC와 휴대폰에 Tailscale을 설치하고 같은 계정으로 로그인합니다.
2. PC에서 Tailscale IP(100.x.x.x)를 확인합니다.
3. 토큰을 정하고 실행합니다.
   ```bash
   HOST=0.0.0.0 HUB_TOKEN=길고-임의의-문자열 npm start
   ```
4. 휴대폰에서 `http://100.x.x.x:4317/?token=길고-임의의-문자열` 로 한 번 접속합니다. 이후로는 토큰이 저장됩니다.

## 테스트

```bash
npm test   # 가짜 CLI로 전체 흐름 검증 (구독 사용량 소모 없음)
```

## 알아둘 제약

- **PC가 켜져 있어야** 작업이 실행됩니다.
- 앱에서 실행한 작업도 **구독 사용량 한도**에 포함됩니다.
- "PC의 기존 세션" 목록은 CLI의 내부 세션 파일을 읽습니다. 이 파일 형식은 공식 규격이 아니어서 CLI 업데이트 후 깨질 수 있습니다. 해당 코드는 `lib/sessions.js` 한 파일에 모아 두었습니다.
- 웹(claude.ai/code, Codex 클라우드)에서 시작한 작업은 대상이 아닙니다.
- **본인 PC에서 쓰는 개인 도구로만** 사용하세요. 구독 로그인을 다른 사람에게 제공하는 용도는 각 서비스 약관상 허용되지 않습니다.

## 구조

```
ai-hub/
├─ server.js          로컬 HTTP 서버 + API + 실시간 스트림(SSE)
├─ lib/agents.js      CLI별 실행 인자와 출력 파서 (Claude stream-json / Codex --json)
├─ lib/runner.js      프로세스 실행, 대기열, 중지, 작업 기록 저장
├─ lib/sessions.js    PC의 기존 세션 파일 수집
├─ public/            화면 (HTML/CSS/JS, 빌드 없음)
├─ scripts/verify.mjs 0단계 검증
└─ test/              가짜 CLI와 스모크 테스트
```

## 다음 단계 (예정)

- 4단계: 완료 알림, 같은 프롬프트를 두 AI에 동시 요청해 나란히 비교
- 5단계: 협업 모드 (작성 → 교차 검토 → 통합, git worktree로 폴더 분리)
