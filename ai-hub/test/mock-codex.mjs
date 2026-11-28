#!/usr/bin/env node
// Codex CLI 흉내 (테스트용): codex exec --json 형식 출력
if (process.argv.includes('--version')) { console.log('mock 1.0.0'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const resume = args[1] === 'resume';
  const sid = resume ? args[args.length - 2] : '0199aaaa-bbbb-cccc-dddd-eeeeffff0000';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'thread.started', thread_id: sid });
  out({ type: 'turn.started' });
  out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } });
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt', exit_code: 0 } });
  await new Promise((s) => setTimeout(s, input.includes('long') ? 3000 : 200));
  if (input.includes('FAIL')) { out({ type: 'turn.failed', error: { message: 'mock failure' } }); process.exit(1); }
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: `받은 지시: ${input.trim()} | 인자: ${args.join(' ')}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
});
