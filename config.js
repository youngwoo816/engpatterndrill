/* Rep English 설정
 * syncUrl: 관리자용 Google Apps Script 웹 앱 주소 (https://script.google.com/macros/s/.../exec)
 * 비워 두면 학습 기록 전송 기능이 꺼지고 앱은 지금처럼 동작합니다.
 * 이 주소는 비밀번호가 아닙니다. 관리자 키는 절대 여기에 넣지 마세요.
 * pushUrl: 학습 알림 서버(Cloudflare 워커) 주소 (https://....workers.dev). 설정 방법은 push/SETUP.md
 * 비워 두면 푸시 알림 대신 캘린더 알림만 보입니다.
 */
window.REP_CONFIG = {
  syncUrl: "",
  pushUrl: "https://rep-english-push.youngwoo816.workers.dev"
};
