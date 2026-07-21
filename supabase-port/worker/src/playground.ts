// Minimal built-in chat playground served at `/` — enough to exercise the
// full stack (auth, agents, SSE chat) without deploying a separate frontend.
export const playgroundHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coze Supabase Port — Playground</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 760px; padding: 16px; }
  h1 { font-size: 18px; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 8px; margin: 4px 0 10px;
    border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; }
  button { padding: 8px 16px; border-radius: 6px; border: 1px solid #8886; cursor: pointer; }
  #log { border: 1px solid #8884; border-radius: 8px; padding: 12px; min-height: 240px;
    white-space: pre-wrap; margin-top: 12px; font-size: 14px; }
  .msg-user { color: #2563eb; }
  .msg-tool { color: #b45309; font-size: 12px; }
  .hint { font-size: 12px; opacity: .7; }
</style>
</head>
<body>
<h1>Coze Supabase Port — Playground</h1>
<p class="hint">Paste a Supabase user access token (or a workspace API key <code>czk_...</code>), the workspace id and agent id, then chat. Streaming via SSE.</p>
<input id="token" placeholder="Bearer token (Supabase JWT or czk_ API key)">
<input id="wid" placeholder="Workspace ID (uuid)">
<input id="agent" placeholder="Agent ID (uuid)">
<textarea id="input" rows="3" placeholder="Message..."></textarea>
<button id="send">Send</button>
<div id="log"></div>
<script>
let conversationId = null;
const log = document.getElementById('log');
function append(text, cls) {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = text;
  log.appendChild(el);
  return el;
}
document.getElementById('send').onclick = async () => {
  const token = document.getElementById('token').value.trim();
  const wid = document.getElementById('wid').value.trim();
  const agent = document.getElementById('agent').value.trim();
  const message = document.getElementById('input').value.trim();
  if (!token || !wid || !agent || !message) { alert('fill in all fields'); return; }
  document.getElementById('input').value = '';
  append('You: ' + message, 'msg-user');
  const reply = append('Agent: ');
  const res = await fetch('/v1/workspaces/' + wid + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ agent_id: agent, conversation_id: conversationId, message })
  });
  if (!res.ok) { reply.textContent = 'Error ' + res.status + ': ' + await res.text(); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      let data;
      try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (event === 'start') conversationId = data.conversation_id;
      else if (event === 'delta') reply.textContent += data.content;
      else if (event === 'tool_call') append('[tool] ' + data.name + '(' + JSON.stringify(data.args) + ')', 'msg-tool');
      else if (event === 'error') append('[error] ' + data.error, 'msg-tool');
    }
  }
};
</script>
</body>
</html>`
