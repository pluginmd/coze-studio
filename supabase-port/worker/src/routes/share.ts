import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Env } from '../env'
import { adminClient } from '../lib/supabase'
import { runChatTurn, ChatError } from '../lib/chatservice'

// Public agent share (connector domain): unauthenticated hosted chat behind an
// unguessable share token. End-users are scoped by a client-generated session
// id (`share:<session>` user_key) for memory/oauth isolation.
export const share = new Hono<{ Bindings: Env }>()

async function loadSharedAgent(env: Env, token: string) {
  const supabase = adminClient(env)
  const { data: agent } = await supabase
    .from('agents')
    .select()
    .eq('share_token', token)
    .maybeSingle()
  return { supabase, agent }
}

share.get('/:token/info', async (c) => {
  const { agent } = await loadSharedAgent(c.env, c.req.param('token')!)
  if (!agent) return c.json({ error: 'invalid share link' }, 404)
  return c.json({
    name: agent.name,
    description: agent.description,
    icon_url: agent.icon_url,
    welcome_message: agent.welcome_message,
    suggested_questions: agent.suggested_questions,
  })
})

share.post('/:token/chat', async (c) => {
  const { supabase, agent } = await loadSharedAgent(c.env, c.req.param('token')!)
  if (!agent) return c.json({ error: 'invalid share link' }, 404)
  const body = await c.req
    .json<{ message?: string; conversation_id?: string; session?: string; attachments?: any[] }>()
    .catch(() => ({}) as any)
  if (!body.message?.trim()) return c.json({ error: 'message is required' }, 400)
  const session = (body.session ?? 'anon').slice(0, 64)

  const params = {
    workspaceId: agent.workspace_id as string,
    agent,
    conversationId: body.conversation_id,
    userId: null,
    userKey: `share:${session}`,
    message: body.message,
    attachments: body.attachments,
  }

  return streamSSE(c, async (stream) => {
    try {
      const result = await runChatTurn(c.env, supabase, params, async (ev) => {
        await stream.writeSSE({ event: String(ev.type), data: JSON.stringify(ev) })
      })
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ conversation_id: result.conversationId, usage: result.usage }),
      })
    } catch (e) {
      const message = e instanceof ChatError ? e.message : String(e).slice(0, 300)
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: message }) })
    }
  })
})

share.get('/:token', (c) => c.html(sharePageHtml))

const sharePageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 680px; padding: 16px; display: flex; flex-direction: column; height: 100dvh; box-sizing: border-box; }
  h1 { font-size: 17px; margin: 4px 0; }
  #desc { font-size: 13px; opacity: .7; margin: 0 0 8px; }
  #log { flex: 1; overflow-y: auto; border: 1px solid #8884; border-radius: 10px; padding: 12px; font-size: 14px; }
  .m { margin: 6px 0; white-space: pre-wrap; }
  .u { color: #2563eb; }
  .t { color: #b45309; font-size: 12px; }
  #bar { display: flex; gap: 8px; margin-top: 10px; }
  #input { flex: 1; padding: 10px; border: 1px solid #8884; border-radius: 8px; background: transparent; color: inherit; }
  button { padding: 10px 18px; border-radius: 8px; border: 1px solid #8886; cursor: pointer; }
  .sq { display: inline-block; margin: 2px; padding: 4px 10px; border: 1px solid #8885; border-radius: 999px; font-size: 12px; cursor: pointer; }
</style>
</head>
<body>
<h1 id="title">Agent</h1>
<p id="desc"></p>
<div id="log"></div>
<div id="sqs"></div>
<div id="bar">
  <input id="input" placeholder="Nhập tin nhắn...">
  <button id="send">Gửi</button>
</div>
<script>
var token = location.pathname.split('/').pop();
var session = localStorage.getItem('share-session');
if (!session) { session = crypto.randomUUID(); localStorage.setItem('share-session', session); }
var conversationId = sessionStorage.getItem('share-conv-' + token) || null;
var log = document.getElementById('log');
function append(text, cls) {
  var el = document.createElement('div');
  el.className = 'm' + (cls ? ' ' + cls : '');
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
fetch('/share/' + token + '/info').then(function (r) { return r.json(); }).then(function (info) {
  if (info.error) { append(info.error); return; }
  document.getElementById('title').textContent = info.name || 'Agent';
  document.getElementById('desc').textContent = info.description || '';
  if (info.welcome_message) append(info.welcome_message);
  (info.suggested_questions || []).forEach(function (q) {
    var s = document.createElement('span');
    s.className = 'sq';
    s.textContent = q;
    s.onclick = function () { document.getElementById('input').value = q; send(); };
    document.getElementById('sqs').appendChild(s);
  });
});
function send() {
  var input = document.getElementById('input');
  var message = input.value.trim();
  if (!message) return;
  input.value = '';
  append('Bạn: ' + message, 'u');
  var reply = append('');
  fetch('/share/' + token + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: message, conversation_id: conversationId, session: session })
  }).then(function (res) {
    if (!res.ok) { res.text().then(function (t) { reply.textContent = 'Lỗi: ' + t; }); return; }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '', event = '';
    function pump() {
      reader.read().then(function (r) {
        if (r.done) return;
        buffer += decoder.decode(r.value, { stream: true });
        var nl;
        while ((nl = buffer.indexOf('\\n')) >= 0) {
          var line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.indexOf('event:') === 0) { event = line.slice(6).trim(); continue; }
          if (line.indexOf('data:') !== 0) continue;
          var data;
          try { data = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (event === 'start') { conversationId = data.conversation_id; sessionStorage.setItem('share-conv-' + token, conversationId); }
          else if (event === 'delta') reply.textContent += data.content;
          else if (event === 'tool_call') append('[đang gọi công cụ: ' + data.name + ']', 't');
          else if (event === 'error') append('[lỗi] ' + data.error, 't');
        }
        pump();
      });
    }
    pump();
  });
}
document.getElementById('send').onclick = send;
document.getElementById('input').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
</script>
</body>
</html>`
