import { consoleStyles } from '../console/styles'
import { clientLib } from '../console/clientlib'

// Public hosted chat page (share links) — reuses the console design system
// and markdown renderer; bubbles, image attachments, suggestions, streaming.
export const sharePageHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>${consoleStyles}
  body { display: block; max-width: 720px; margin: 0 auto; padding: 14px; height: auto; min-height: 100dvh; }
  .sharehead { display: flex; gap: 12px; align-items: center; padding: 6px 2px 12px; }
  .sharehead .logo { width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(135deg, var(--primary), #a855f7); display: flex; align-items: center; justify-content: center; font-size: 20px; color: #fff; }
  .sharehead h1 { font-size: 16px; margin: 0; }
  .sharehead .sub { font-size: 12px; }
  #chatlog { min-height: 50vh; }
</style>
</head>
<body>
<div class="sharehead"><div class="logo">🤖</div><div><h1 id="title">Agent</h1><div class="sub" id="desc"></div></div></div>
<div id="chatlog"></div>
<div class="row" id="sq"></div>
<div class="attachrow" id="attrow"></div>
<div class="chatbar">
  <button class="btn" id="attbtn" title="Đính kèm ảnh">🖼</button>
  <textarea id="input" rows="1" placeholder="Nhập tin nhắn…"></textarea>
  <button class="btn primary" id="send">➤</button>
</div>
<input type="file" id="filein" accept="image/*" style="display:none">
<div id="toasts"></div>
<script>
${clientLib}
var shareToken = location.pathname.split('/').pop();
var session = localStorage.getItem('share-session');
if (!session) { session = crypto.randomUUID(); localStorage.setItem('share-session', session); }
var conv = sessionStorage.getItem('share-conv-' + shareToken) || null;
var log = document.getElementById('chatlog');
var sq = document.getElementById('sq');
var attach = [];

function bubble(role, streaming) {
  var bub = el('div', { class: 'bub' });
  var msg = el('div', { class: 'msg ' + (role === 'user' ? 'user' : 'ai') },
    el('div', { class: 'av', text: role === 'user' ? '🧑' : '🤖' }), bub);
  log.appendChild(msg); log.scrollTop = log.scrollHeight;
  return { bub: bub, setMd: function(text, s){ bub.innerHTML = '<div class="md">' + md(text) + (s ? '<span class="cursor"></span>' : '') + '</div>'; log.scrollTop = log.scrollHeight; } };
}
function showSug(list) {
  sq.innerHTML = '';
  (list || []).forEach(function(q){ sq.appendChild(el('button', { class: 'chip', text: q, onclick: function(){ send(q); } })); });
}
fetch('/share/' + shareToken + '/info').then(function(r){ return r.json(); }).then(function(info){
  if (info.error) { bubble('ai').setMd('❌ ' + info.error); return; }
  document.getElementById('title').textContent = info.name || 'Agent';
  document.getElementById('desc').textContent = info.description || '';
  if (info.welcome_message) bubble('ai').setMd(info.welcome_message);
  showSug(info.suggested_questions);
});
document.getElementById('attbtn').onclick = function(){ document.getElementById('filein').click(); };
document.getElementById('filein').onchange = function(ev){
  var f = ev.target.files[0]; if (!f) return;
  fileToB64(f).then(function(b64){
    var a = { type: 'image', base64: b64, mime: f.type };
    attach.push(a);
    var img = el('img', { src: 'data:' + f.type + ';base64,' + b64 });
    var w = el('div', { class: 'att' }, img, el('button', { class: 'x', text: '✕', onclick: function(){ attach.splice(attach.indexOf(a), 1); w.remove(); } }));
    document.getElementById('attrow').appendChild(w);
  });
  ev.target.value = '';
};
var input = document.getElementById('input');
input.addEventListener('keydown', function(ev){ if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(input.value); } });
document.getElementById('send').onclick = function(){ send(input.value); };
function send(text) {
  text = (text || '').trim(); if (!text) return;
  input.value = ''; showSug([]);
  bubble('user').setMd(text);
  var payload = attach.slice(); attach.length = 0; document.getElementById('attrow').innerHTML = '';
  var a = bubble('ai'); a.setMd('', true);
  var raw = '';
  fetch('/share/' + shareToken + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, conversation_id: conv, session: session, attachments: payload })
  }).then(function(res){
    if (!res.ok) return res.text().then(function(t){ a.setMd('❌ ' + t); });
    return readSSE(res, function(event, data){
      if (event === 'start') { conv = data.conversation_id; sessionStorage.setItem('share-conv-' + shareToken, conv); }
      else if (event === 'delta') { raw += data.content; a.setMd(raw, true); }
      else if (event === 'tool_call') a.bub.appendChild(el('div', { class: 'toolinfo', text: '🔧 ' + data.name }));
      else if (event === 'suggestion') showSug(data.suggestions);
      else if (event === 'done') { a.setMd(raw || '(trống)'); if (data.suggestions) showSug(data.suggestions); }
      else if (event === 'error') a.setMd(raw + '\\n\\n❌ ' + data.error);
    }).then(function(){ a.setMd(raw || '(trống)'); });
  }).catch(function(){ a.setMd(raw + '\\n\\n⏹'); });
}
</script>
</body>
</html>`
