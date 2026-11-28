#!/usr/bin/env node
// Claude Code CLI 흉내 (테스트용): stdin 프롬프트를 받아 stream-json 출력
if (process.argv.includes('--version')) { console.log('mock 1.0.0'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const r = args.indexOf('--resume');
  const sid = r >= 0 ? args[r + 1] : 'mock-claude-session-1';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'mock' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file contents' }] } });
  await new Promise((s) => setTimeout(s, input.includes('long') ? 3000 : 200));
  const text = `받은 지시: ${input.trim()} | 인자: ${args.join(' ')}`;
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, duration_ms: 1200, num_turns: 2 });
});
