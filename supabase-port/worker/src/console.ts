// Lean admin console — a single-file SPA served at `/`. Covers the full API
// surface: agents (edit/publish/share/chat), knowledge, workflows, plugins,
// databases (+import), prompts, API keys, usage, search. No build step; JSON
// editors are used for structured fields to stay compact.
export const consoleHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coze Supabase Port — Console</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; }
  body { margin: 0; display: flex; height: 100dvh; }
  #side { width: 190px; border-right: 1px solid #8883; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
  #side h1 { font-size: 14px; margin: 0 0 8px; }
  #side button { text-align: left; padding: 7px 10px; border: 0; background: none; color: inherit; border-radius: 7px; cursor: pointer; font-size: 13px; }
  #side button.active { background: #6366f133; }
  #main { flex: 1; overflow-y: auto; padding: 18px 22px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
  th, td { border-bottom: 1px solid #8883; padding: 6px 8px; text-align: left; vertical-align: top; }
  input, select, textarea { padding: 7px; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; font-size: 13px; box-sizing: border-box; }
  textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 12px; }
  button.b { padding: 7px 14px; border-radius: 6px; border: 1px solid #8886; background: none; color: inherit; cursor: pointer; font-size: 13px; }
  button.b.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 14px; margin: 10px 0; }
  .muted { opacity: .65; font-size: 12px; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #8885; }
  a.link { color: #6366f1; cursor: pointer; text-decoration: underline; }
  #chatlog { border: 1px solid #8883; border-radius: 10px; padding: 12px; height: 50vh; overflow-y: auto; white-space: pre-wrap; }
  .cu { color: #2563eb; } .ct { color: #b45309; font-size: 12px; }
  #toast { position: fixed; bottom: 14px; right: 14px; background: #111c; color: #fff; padding: 9px 14px; border-radius: 8px; display: none; max-width: 40ch; }
</style>
</head>
<body>
<div id="side">
  <h1>⚡ Coze Port</h1>
  <select id="wsel" style="width:100%"></select>
  <div style="height:8px"></div>
</div>
<div id="main"></div>
<div id="toast"></div>
<script>
'use strict';
var S = { token: localStorage.getItem('cz-token') || '', wid: localStorage.getItem('cz-wid') || '', view: 'agents' };
var VIEWS = ['agents','chat','knowledge','workflows','plugins','databases','apps','prompts','keys','usage','search','settings'];
var LABELS = { agents:'Agents', chat:'Chat', knowledge:'Knowledge', workflows:'Workflows', plugins:'Plugins', databases:'Databases', apps:'Apps', prompts:'Prompts', keys:'API Keys', usage:'Usage', search:'Search', settings:'Settings' };

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(function(){ t.style.display = 'none'; }, 3500);
}
function api(method, path, body) {
  return fetch('/v1' + path, {
    method: method,
    headers: { 'authorization': 'Bearer ' + S.token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || r.status); return j; }); });
}
function wapi(method, path, body) { return api(method, '/workspaces/' + S.wid + path, body); }
function el(tag, attrs) {
  var e = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function(k){
    if (k === 'onclick') e.onclick = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  });
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c) e.appendChild(c); }
  return e;
}
function jsonBox(value, rows) {
  return el('textarea', { rows: rows || 8, text: JSON.stringify(value, null, 2) });
}
function readJson(box) { try { return JSON.parse(box.value); } catch (e) { throw new Error('JSON không hợp lệ: ' + e.message); } }
function main() { var m = document.getElementById('main'); m.innerHTML = ''; return m; }
function err(e) { toast('❌ ' + (e && e.message || e)); }

// ---------- sidebar / workspaces ----------
function buildNav() {
  var side = document.getElementById('side');
  VIEWS.forEach(function(v){
    var b = el('button', { text: LABELS[v], id: 'nav-' + v, onclick: function(){ go(v); } });
    side.appendChild(b);
  });
}
function go(view) {
  S.view = view;
  VIEWS.forEach(function(v){ document.getElementById('nav-' + v).classList.toggle('active', v === view); });
  ({ agents: rAgents, chat: rChat, knowledge: rKnowledge, workflows: rWorkflows, plugins: rPlugins,
     databases: rDatabases, apps: rApps, prompts: rPrompts, keys: rKeys, usage: rUsage, search: rSearch, settings: rSettings })[view]();
}
function loadWorkspaces() {
  return api('GET', '/workspaces').then(function(list){
    var sel = document.getElementById('wsel'); sel.innerHTML = '';
    list.forEach(function(w){ sel.appendChild(el('option', { value: w.id, text: w.name })); });
    sel.appendChild(el('option', { value: '__new', text: '+ Tạo workspace...' }));
    if (!S.wid && list.length) S.wid = list[0].id;
    sel.value = S.wid;
    localStorage.setItem('cz-wid', S.wid);
    sel.onchange = function(){
      if (sel.value === '__new') {
        var name = prompt('Tên workspace:'); if (!name) { sel.value = S.wid; return; }
        api('POST', '/workspaces', { name: name }).then(function(w){ S.wid = w.id; loadWorkspaces().then(function(){ go(S.view); }); }).catch(err);
      } else { S.wid = sel.value; localStorage.setItem('cz-wid', S.wid); go(S.view); }
    };
  });
}

// ---------- agents ----------
function rAgents() {
  var m = main();
  m.appendChild(el('h2', { text: 'Agents' }));
  var bar = el('div', { class: 'row' });
  var nameIn = el('input', { placeholder: 'Tên agent mới' });
  bar.appendChild(nameIn);
  bar.appendChild(el('button', { class: 'b primary', text: 'Tạo', onclick: function(){
    if (!nameIn.value.trim()) return;
    wapi('POST', '/agents', { name: nameIn.value.trim(), prompt: 'You are a helpful assistant.' })
      .then(function(a){ editAgent(a.id); }).catch(err);
  }}));
  m.appendChild(bar);
  var box = el('div'); m.appendChild(box);
  wapi('GET', '/agents').then(function(list){
    var t = el('table');
    t.appendChild(el('tr', {}, el('th', { text: 'Tên' }), el('th', { text: 'Trạng thái' }), el('th', { text: 'Cập nhật' }), el('th')));
    list.forEach(function(a){
      var open = el('a', { class: 'link', text: 'Mở', onclick: function(){ editAgent(a.id); } });
      t.appendChild(el('tr', {}, el('td', { text: a.name }), el('td', {}, el('span', { class: 'pill', text: a.status })),
        el('td', { class: 'muted', text: (a.updated_at || '').slice(0, 16) }), el('td', {}, open)));
    });
    box.appendChild(t);
  }).catch(err);
}
var EDITABLE_AGENT = ['name','description','prompt','model','welcome_message','suggested_questions','dataset_ids','plugin_tool_ids','workflow_ids','database_ids','shortcuts','variables'];
function editAgent(id) {
  var m = main();
  wapi('GET', '/agents/' + id).then(function(a){
    m.appendChild(el('h2', { text: 'Agent: ' + a.name }));
    m.appendChild(el('div', { class: 'muted', text: 'id: ' + a.id + (a.share_token ? ' · share: ' + location.origin + '/share/' + a.share_token : '') }));
    var subset = {}; EDITABLE_AGENT.forEach(function(k){ subset[k] = a[k]; });
    var box = jsonBox(subset, 22);
    m.appendChild(el('div', { class: 'card' }, box));
    var bar = el('div', { class: 'row' });
    bar.appendChild(el('button', { class: 'b primary', text: 'Lưu', onclick: function(){
      try { wapi('PATCH', '/agents/' + id, readJson(box)).then(function(){ toast('✅ Đã lưu'); }).catch(err); } catch (e) { err(e); }
    }}));
    bar.appendChild(el('button', { class: 'b', text: 'Publish', onclick: function(){
      wapi('POST', '/agents/' + id + '/publish').then(function(r){ toast('✅ Publish v' + r.version); }).catch(err);
    }}));
    bar.appendChild(el('button', { class: 'b', text: 'Share link', onclick: function(){
      wapi('POST', '/agents/' + id + '/share').then(function(r){ prompt('Public chat URL:', r.url); editAgent(id); }).catch(err);
    }}));
    bar.appendChild(el('button', { class: 'b', text: 'Chat thử', onclick: function(){ go('chat'); setTimeout(function(){ var s = document.getElementById('chat-agent'); if (s) { s.value = id; } }, 300); } }));
    bar.appendChild(el('button', { class: 'b', text: 'Xóa', onclick: function(){
      if (confirm('Xóa agent này?')) wapi('DELETE', '/agents/' + id).then(rAgents).catch(err);
    }}));
    bar.appendChild(el('button', { class: 'b', text: '← Danh sách', onclick: rAgents }));
    m.appendChild(bar);
  }).catch(err);
}

// ---------- chat ----------
var chatConv = null;
var chatAbort = null;
function rChat() {
  var m = main();
  m.appendChild(el('h2', { text: 'Chat' }));
  var sel = el('select', { id: 'chat-agent' });
  var bar = el('div', { class: 'row' }, sel,
    el('button', { class: 'b', text: 'Hội thoại mới', onclick: function(){ chatConv = null; document.getElementById('chatlog').innerHTML = ''; } }));
  m.appendChild(bar);
  m.appendChild(el('div', { id: 'chatlog' }));
  var sq = el('div', { id: 'chat-sq' });
  m.appendChild(sq);
  var input = el('input', { placeholder: 'Tin nhắn... (Enter để gửi)', style: 'flex:1' });
  var stopBtn = el('button', { class: 'b', text: '⏹ Dừng', onclick: function(){ if (chatAbort) chatAbort.abort(); } });
  m.appendChild(el('div', { class: 'row' }, input, el('button', { class: 'b primary', text: 'Gửi', onclick: function(){ send(input.value); } }), stopBtn));
  wapi('GET', '/agents').then(function(list){
    list.forEach(function(a){ sel.appendChild(el('option', { value: a.id, text: a.name })); });
  }).catch(err);
  input.addEventListener('keydown', function(e){ if (e.key === 'Enter') send(input.value); });
  function append(text, cls) {
    var log = document.getElementById('chatlog');
    var d = el('div', { text: text }); if (cls) d.className = cls;
    log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }
  function showSuggestions(list) {
    sq.innerHTML = '';
    (list || []).forEach(function(q){
      var chip = el('button', { class: 'b', text: q, onclick: function(){ send(q); } });
      chip.style.fontSize = '12px'; chip.style.margin = '2px';
      sq.appendChild(chip);
    });
  }
  function send(message) {
    message = (message || '').trim(); if (!message || !sel.value) return;
    input.value = ''; showSuggestions([]);
    append('Bạn: ' + message, 'cu');
    var reply = append('');
    chatAbort = new AbortController();
    fetch('/v1/workspaces/' + S.wid + '/chat', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + S.token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: sel.value, conversation_id: chatConv, message: message }),
      signal: chatAbort.signal
    }).then(function(res){
      if (!res.ok) { res.text().then(function(t){ reply.textContent = 'Lỗi: ' + t; }); return; }
      var reader = res.body.getReader(); var dec = new TextDecoder(); var buf = ''; var event = '';
      (function pump(){ reader.read().then(function(r){
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          var line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line.indexOf('event:') === 0) { event = line.slice(6).trim(); continue; }
          if (line.indexOf('data:') !== 0) continue;
          var data; try { data = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (event === 'start') chatConv = data.conversation_id;
          else if (event === 'delta') reply.textContent += data.content;
          else if (event === 'tool_call') append('[gọi tool: ' + data.name + ']', 'ct');
          else if (event === 'suggestion') showSuggestions(data.suggestions);
          else if (event === 'done' && data.suggestions) showSuggestions(data.suggestions);
          else if (event === 'error') append('[lỗi] ' + data.error, 'ct');
        }
        pump();
      }).catch(function(){ append('[đã dừng — phần trả lời dở được lưu là broken]', 'ct'); }); })();
    }).catch(function(){ append('[đã dừng]', 'ct'); });
  }
}

// ---------- knowledge ----------
function rKnowledge() {
  var m = main();
  m.appendChild(el('h2', { text: 'Knowledge (datasets)' }));
  var nameIn = el('input', { placeholder: 'Tên dataset mới' });
  m.appendChild(el('div', { class: 'row' }, nameIn, el('button', { class: 'b primary', text: 'Tạo', onclick: function(){
    if (nameIn.value.trim()) wapi('POST', '/datasets', { name: nameIn.value.trim() }).then(rKnowledge).catch(err);
  }})));
  var box = el('div'); m.appendChild(box);
  wapi('GET', '/datasets').then(function(list){
    list.forEach(function(ds){
      var card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'row' },
        el('b', { text: ds.name }), el('span', { class: 'muted', text: ds.id }),
        el('button', { class: 'b', text: 'Xóa', onclick: function(){ if (confirm('Xóa dataset?')) wapi('DELETE', '/datasets/' + ds.id).then(rKnowledge).catch(err); } })));
      var file = el('input', { type: 'file' });
      card.appendChild(el('div', { class: 'row' }, file,
        el('button', { class: 'b', text: 'Upload & index', onclick: function(){
          var f = file.files[0]; if (!f) return;
          var rd = new FileReader();
          rd.onload = function(){
            var b64 = rd.result.split(',')[1];
            wapi('POST', '/datasets/' + ds.id + '/documents', { name: f.name, content_base64: b64 })
              .then(function(){ toast('✅ Đang index ' + f.name); setTimeout(function(){ listDocs(ds.id, docsBox); }, 1500); }).catch(err);
          };
          rd.readAsDataURL(f);
        }})));
      var q = el('input', { placeholder: 'Test tìm kiếm hybrid...' , style: 'flex:1' });
      var res = el('div');
      card.appendChild(el('div', { class: 'row' }, q, el('button', { class: 'b', text: 'Tìm', onclick: function(){
        wapi('POST', '/datasets/' + ds.id + '/search', { query: q.value }).then(function(chunks){
          res.innerHTML = '';
          chunks.forEach(function(ch){ res.appendChild(el('div', { class: 'card', text: '[' + ch.score.toFixed(3) + '] ' + ch.content.slice(0, 300) })); });
        }).catch(err);
      }})));
      card.appendChild(res);
      var docsBox = el('div'); card.appendChild(docsBox);
      listDocs(ds.id, docsBox);
      box.appendChild(card);
    });
  }).catch(err);
  function listDocs(dsid, docsBox) {
    wapi('GET', '/datasets/' + dsid + '/documents').then(function(docs){
      docsBox.innerHTML = '';
      if (!docs.length) return;
      var t = el('table');
      t.appendChild(el('tr', {}, el('th', { text: 'Tài liệu' }), el('th', { text: 'Trạng thái' }), el('th', { text: 'Chunks' }), el('th')));
      docs.forEach(function(d){
        var acts = el('td', {},
          el('a', { class: 'link', text: 'chunks', onclick: function(){ viewChunks(dsid, d.id, d.name); } }),
          document.createTextNode(' '),
          el('a', { class: 'link', text: 'reindex', onclick: function(){ wapi('POST', '/datasets/' + dsid + '/documents/' + d.id + '/reindex').then(function(){ toast('✅ reindex'); }).catch(err); } }),
          document.createTextNode(' '),
          el('a', { class: 'link', text: 'xóa', onclick: function(){ wapi('DELETE', '/datasets/' + dsid + '/documents/' + d.id).then(function(){ listDocs(dsid, docsBox); }).catch(err); } }));
        t.appendChild(el('tr', {}, el('td', { text: d.name }),
          el('td', { text: d.status + (d.error ? ' — ' + d.error.slice(0, 80) : '') }),
          el('td', { text: String(d.chunk_count) }), acts));
      });
      docsBox.appendChild(t);
    }).catch(err);
  }
}

function viewChunks(dsid, docid, docName) {
  var m = main();
  m.appendChild(el('h2', { text: 'Chunks: ' + docName }));
  var addBox = el('textarea', { rows: 3, placeholder: 'Nội dung chunk mới (sẽ được embed ngay)...' });
  m.appendChild(el('div', { class: 'card' }, addBox,
    el('button', { class: 'b primary', text: '+ Thêm chunk', onclick: function(){
      if (!addBox.value.trim()) return;
      wapi('POST', '/datasets/' + dsid + '/documents/' + docid + '/chunks', { content: addBox.value })
        .then(function(){ viewChunks(dsid, docid, docName); }).catch(err);
    }})));
  var listBox = el('div'); m.appendChild(listBox);
  m.appendChild(el('button', { class: 'b', text: '← Knowledge', onclick: rKnowledge }));
  wapi('GET', '/datasets/' + dsid + '/documents/' + docid + '/chunks?limit=100').then(function(chunks){
    chunks.forEach(function(ch){
      var card = el('div', { class: 'card' });
      if (!ch.enabled) card.style.opacity = '0.5';
      card.appendChild(el('div', { class: 'muted', text: '#' + ch.seq + (ch.enabled ? '' : ' (disabled)') }));
      card.appendChild(el('div', { text: ch.content.slice(0, 400) }));
      card.appendChild(el('div', { class: 'row' },
        el('a', { class: 'link', text: ch.enabled ? 'disable' : 'enable', onclick: function(){
          wapi('PATCH', '/datasets/' + dsid + '/chunks/' + ch.id, { enabled: !ch.enabled })
            .then(function(){ viewChunks(dsid, docid, docName); }).catch(err);
        }}),
        el('a', { class: 'link', text: 'sửa', onclick: function(){
          var next = prompt('Nội dung mới (sẽ re-embed):', ch.content); if (next === null) return;
          wapi('PATCH', '/datasets/' + dsid + '/chunks/' + ch.id, { content: next })
            .then(function(){ viewChunks(dsid, docid, docName); }).catch(err);
        }}),
        el('a', { class: 'link', text: 'xóa', onclick: function(){
          wapi('DELETE', '/datasets/' + dsid + '/chunks/' + ch.id)
            .then(function(){ viewChunks(dsid, docid, docName); }).catch(err);
        }})));
      listBox.appendChild(card);
    });
    if (!chunks.length) listBox.appendChild(el('div', { class: 'muted', text: 'Chưa có chunk.' }));
  }).catch(err);
}

// ---------- visual workflow editor ----------
var NODE_TYPES = ['start','end','llm','intent','knowledge_retrieve','knowledge_index','knowledge_delete','plugin','http','database_query','database_insert','database_update','database_delete','condition','selector','loop','batch','sub_workflow','question','input','variable_assign','output_emitter','conversation_create','conversation_update','conversation_delete','conversation_list','conversation_clear','message_create','message_edit','message_delete','message_list','template','code','text_processor','json_parse','json_stringify','variable_aggregator'];

function svgEl(tag, attrs) {
  var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) Object.keys(attrs).forEach(function(k){ e.setAttribute(k, attrs[k]); });
  return e;
}

function visualEditor(wf, backFn) {
  var m = main();
  var graph = wf.graph || { nodes: [], edges: [] };
  graph.nodes = graph.nodes || []; graph.edges = graph.edges || [];
  var selected = null, connectFrom = null, nextNum = 1;

  // auto-layout nodes missing _pos: columns by BFS depth
  (function layout(){
    var depth = {}, inbound = {};
    graph.edges.forEach(function(e){ inbound[e.target] = (inbound[e.target] || 0) + 1; });
    var queue = graph.nodes.filter(function(n){ return !inbound[n.id]; }).map(function(n){ return [n.id, 0]; });
    var seen = {};
    while (queue.length) {
      var item = queue.shift(); var id = item[0]; var d = item[1];
      if (seen[id]) continue; seen[id] = true; depth[id] = d;
      graph.edges.filter(function(e){ return e.source === id; }).forEach(function(e){ queue.push([e.target, d + 1]); });
    }
    var colCount = {};
    graph.nodes.forEach(function(n){
      n.data = n.data || {};
      if (!n.data._pos) {
        var d = depth[n.id] || 0;
        colCount[d] = (colCount[d] || 0) + 1;
        n.data._pos = { x: 40 + d * 230, y: 40 + (colCount[d] - 1) * 110 };
      }
    });
  })();

  m.appendChild(el('div', { class: 'row' },
    el('button', { class: 'b', text: '← Quay lại', onclick: function(){ backFn(); } }),
    el('b', { text: '🎨 ' + wf.name }),
    el('button', { class: 'b primary', text: '💾 Lưu graph', onclick: function(){
      wapi('PATCH', '/workflows/' + wf.id, { graph: graph }).then(function(){ toast('✅ Đã lưu'); }).catch(err);
    }}),
    el('button', { class: 'b', text: '+ Thêm node', onclick: addNode }),
    el('span', { class: 'muted', text: 'Kéo để di chuyển · click chọn · "Nối tới" rồi click node đích · click nhãn edge để xóa' })));

  var wrap = el('div', { style: 'display:flex; gap:12px; height: calc(100dvh - 120px);' });
  var canvasBox = el('div', { style: 'flex:1; overflow:auto; border:1px solid #8884; border-radius:10px;' });
  var svg = svgEl('svg', { width: 2400, height: 1400 });
  var defs = svgEl('defs');
  var marker = svgEl('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  var arrPath = svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#6366f1' });
  marker.appendChild(arrPath); defs.appendChild(marker); svg.appendChild(defs);
  canvasBox.appendChild(svg);
  var panel = el('div', { style: 'width: 320px; overflow-y:auto;' });
  wrap.appendChild(canvasBox); wrap.appendChild(panel);
  m.appendChild(wrap);

  var drag = null;
  svg.addEventListener('mousemove', function(e){
    if (!drag) return;
    var rect = svg.getBoundingClientRect();
    drag.node.data._pos.x = Math.max(0, e.clientX - rect.left - drag.dx);
    drag.node.data._pos.y = Math.max(0, e.clientY - rect.top - drag.dy);
    drag.moved = true;
    render();
  });
  svg.addEventListener('mouseup', function(){ if (drag && !drag.moved) onNodeClick(drag.node); drag = null; });
  svg.addEventListener('mouseleave', function(){ drag = null; });

  function onNodeClick(node) {
    if (connectFrom && connectFrom.id !== node.id) {
      var label = prompt('Nhãn edge (trống = thường; true/false cho condition; tên nhánh cho selector/intent; error cho error-branch):', '');
      if (label !== null) {
        graph.edges.push(label ? { source: connectFrom.id, target: node.id, label: label } : { source: connectFrom.id, target: node.id });
      }
      connectFrom = null;
      selected = node;
    } else {
      selected = node;
      connectFrom = null;
    }
    render(); renderPanel();
  }

  function addNode() {
    var id = prompt('ID node mới:', 'n' + nextNum++);
    if (!id) return;
    if (graph.nodes.some(function(n){ return n.id === id; })) { toast('❌ ID đã tồn tại'); return; }
    var type = prompt('Loại node (' + NODE_TYPES.slice(0, 8).join(', ') + ', ...):', 'llm');
    if (!type) return;
    var box = canvasBox;
    graph.nodes.push({ id: id, type: type, data: { _pos: { x: box.scrollLeft + 60, y: box.scrollTop + 60 } } });
    selected = graph.nodes[graph.nodes.length - 1];
    render(); renderPanel();
  }

  function render() {
    while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
    var byId = {};
    graph.nodes.forEach(function(n){ byId[n.id] = n; });
    graph.edges.forEach(function(edge, idx){
      var s = byId[edge.source], t = byId[edge.target];
      if (!s || !t) return;
      var x1 = s.data._pos.x + 180, y1 = s.data._pos.y + 32;
      var x2 = t.data._pos.x, y2 = t.data._pos.y + 32;
      var mx = (x1 + x2) / 2;
      var path = svgEl('path', {
        d: 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2,
        fill: 'none', stroke: edge.label === 'error' ? '#dc2626' : '#6366f1', 'stroke-width': 2, 'marker-end': 'url(#arr)'
      });
      path.style.cursor = 'pointer';
      path.addEventListener('click', function(){ removeEdge(idx); });
      svg.appendChild(path);
      var lbl = svgEl('text', { x: mx, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor' });
      lbl.textContent = edge.label ? edge.label : '';
      lbl.style.cursor = 'pointer';
      lbl.addEventListener('click', function(){ removeEdge(idx); });
      svg.appendChild(lbl);
    });
    graph.nodes.forEach(function(node){
      var g = svgEl('g', {});
      var isSel = selected && selected.id === node.id;
      var rect = svgEl('rect', {
        x: node.data._pos.x, y: node.data._pos.y, width: 180, height: 64, rx: 10,
        fill: isSel ? '#6366f133' : '#8881', stroke: connectFrom && connectFrom.id === node.id ? '#f59e0b' : (isSel ? '#6366f1' : '#8886'), 'stroke-width': 2
      });
      var t1 = svgEl('text', { x: node.data._pos.x + 12, y: node.data._pos.y + 26, 'font-size': 13, 'font-weight': 600, fill: 'currentColor' });
      t1.textContent = node.id;
      var t2 = svgEl('text', { x: node.data._pos.x + 12, y: node.data._pos.y + 46, 'font-size': 11, fill: '#6366f1' });
      t2.textContent = node.type;
      g.appendChild(rect); g.appendChild(t1); g.appendChild(t2);
      g.style.cursor = 'grab';
      g.addEventListener('mousedown', function(e){
        var r = svg.getBoundingClientRect();
        drag = { node: node, dx: e.clientX - r.left - node.data._pos.x, dy: e.clientY - r.top - node.data._pos.y, moved: false };
        e.preventDefault();
      });
      svg.appendChild(g);
    });
  }

  function removeEdge(idx) {
    var e = graph.edges[idx];
    if (confirm('Xóa edge ' + e.source + ' → ' + e.target + (e.label ? ' [' + e.label + ']' : '') + '?')) {
      graph.edges.splice(idx, 1);
      render();
    }
  }

  function renderPanel() {
    panel.innerHTML = '';
    if (!selected) { panel.appendChild(el('div', { class: 'muted', text: 'Chọn một node để cấu hình.' })); return; }
    var node = selected;
    panel.appendChild(el('h2', { text: node.id }));
    var typeSel = el('select', { style: 'width:100%' });
    NODE_TYPES.forEach(function(t){ typeSel.appendChild(el('option', { value: t, text: t })); });
    typeSel.value = node.type;
    var dataCopy = {}; Object.keys(node.data).forEach(function(k){ if (k !== '_pos') dataCopy[k] = node.data[k]; });
    var dataBox = el('textarea', { rows: 14, text: JSON.stringify(dataCopy, null, 2) });
    panel.appendChild(el('div', { class: 'card' },
      el('div', { class: 'muted', text: 'type:' }), typeSel,
      el('div', { class: 'muted', text: 'data:' }), dataBox,
      el('div', { class: 'row' },
        el('button', { class: 'b primary', text: 'Cập nhật', onclick: function(){
          try {
            var parsed = JSON.parse(dataBox.value || '{}');
            parsed._pos = node.data._pos;
            node.data = parsed;
            node.type = typeSel.value;
            toast('✅ Node updated (nhớ Lưu graph)');
            render();
          } catch (e) { err(e); }
        }}),
        el('button', { class: 'b', text: '→ Nối tới...', onclick: function(){ connectFrom = node; toast('Chọn node đích để nối'); render(); } }),
        el('button', { class: 'b', text: 'Xóa node', onclick: function(){
          if (!confirm('Xóa node ' + node.id + ' và các edge liên quan?')) return;
          graph.nodes = graph.nodes.filter(function(n){ return n.id !== node.id; });
          graph.edges = graph.edges.filter(function(e){ return e.source !== node.id && e.target !== node.id; });
          selected = null; render(); renderPanel();
        }}))));
    panel.appendChild(el('div', { class: 'muted', text: 'Nhãn edge đặc biệt: true/false (condition), tên nhánh (selector/intent), error (error-branch).' }));
  }

  render(); renderPanel();
}

// ---------- generic JSON-resource sections ----------
function jsonSection(title, base, createBody, editableKeys, extraActions) {
  return function() {
    var m = main();
    m.appendChild(el('h2', { text: title }));
    var nameIn = el('input', { placeholder: 'Tên mới' });
    m.appendChild(el('div', { class: 'row' }, nameIn, el('button', { class: 'b primary', text: 'Tạo', onclick: function(){
      if (!nameIn.value.trim()) return;
      wapi('POST', base, createBody(nameIn.value.trim())).then(function(x){ openItem(x.id); }).catch(err);
    }})));
    var box = el('div'); m.appendChild(box);
    wapi('GET', base).then(function(list){
      var t = el('table');
      t.appendChild(el('tr', {}, el('th', { text: 'Tên' }), el('th', { text: 'Cập nhật' }), el('th')));
      list.forEach(function(x){
        t.appendChild(el('tr', {}, el('td', { text: x.name }), el('td', { class: 'muted', text: (x.updated_at || x.created_at || '').slice(0, 16) }),
          el('td', {}, el('a', { class: 'link', text: 'Mở', onclick: function(){ openItem(x.id); } }))));
      });
      box.appendChild(t);
    }).catch(err);
    function openItem(id) {
      var m2 = main();
      wapi('GET', base + '/' + id).then(function(x){
        m2.appendChild(el('h2', { text: title + ': ' + x.name }));
        m2.appendChild(el('div', { class: 'muted', text: 'id: ' + x.id }));
        var subset = {}; editableKeys.forEach(function(k){ subset[k] = x[k]; });
        var boxEd = jsonBox(subset, 20);
        m2.appendChild(el('div', { class: 'card' }, boxEd));
        var bar = el('div', { class: 'row' });
        bar.appendChild(el('button', { class: 'b primary', text: 'Lưu', onclick: function(){
          try { wapi('PATCH', base + '/' + id, readJson(boxEd)).then(function(){ toast('✅ Đã lưu'); }).catch(err); } catch (e) { err(e); }
        }}));
        bar.appendChild(el('button', { class: 'b', text: 'Xóa', onclick: function(){
          if (confirm('Xóa?')) wapi('DELETE', base + '/' + id).then(jsonSection(title, base, createBody, editableKeys, extraActions)).catch(err);
        }}));
        bar.appendChild(el('button', { class: 'b', text: '← Danh sách', onclick: jsonSection(title, base, createBody, editableKeys, extraActions) }));
        m2.appendChild(bar);
        if (extraActions) extraActions(m2, x);
      }).catch(err);
    }
  };
}

var rWorkflows = jsonSection('Workflows', '/workflows',
  function(name){ return { name: name, graph: { nodes: [ { id: 'start', type: 'start', data: { inputs: [] } }, { id: 'end', type: 'end', data: { template: '' } } ], edges: [ { source: 'start', target: 'end' } ] } }; },
  ['name','description','status','graph'],
  function(m, wf) {
    var inBox = jsonBox({}, 4);
    var out = el('div');
    function renderOutcome(r) {
      out.innerHTML = '';
      if (r.status === 'suspended') {
        var ans = el('input', { placeholder: 'Câu trả lời...' , style: 'flex:1' });
        var card = el('div', { class: 'card' },
          el('div', {}, el('b', { text: '⏸ Workflow đang chờ: ' }), document.createTextNode(r.question || '')),
          el('div', { class: 'muted', text: (r.options || []).length ? 'Lựa chọn: ' + r.options.join(' | ') : '' }),
          el('div', { class: 'row' }, ans, el('button', { class: 'b primary', text: 'Trả lời & tiếp tục', onclick: function(){
            wapi('POST', '/workflows/' + wf.id + '/runs/' + r.run_id + '/resume', { value: ans.value })
              .then(renderOutcome).catch(err);
          }})));
        out.appendChild(card);
      } else {
        out.appendChild(jsonBox(r, 14));
      }
    }
    m.appendChild(el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('button', { class: 'b primary', text: '🎨 Visual editor', onclick: function(){
          visualEditor(wf, function(){ rWorkflows(); });
        }}),
        el('button', { class: 'b', text: '📦 Publish version', onclick: function(){
          wapi('POST', '/workflows/' + wf.id + '/publish').then(function(r){ toast('✅ Publish v' + r.version); }).catch(err);
        }}),
        el('span', { class: 'muted', text: 'Run với input:' })),
      inBox,
      el('button', { class: 'b primary', text: '▶ Run', onclick: function(){
        try {
          wapi('POST', '/workflows/' + wf.id + '/run', { input: readJson(inBox) })
            .then(renderOutcome)
            .catch(function(e){ out.innerHTML = ''; out.appendChild(el('div', { class: 'card', text: '❌ ' + e.message })); });
        } catch (e) { err(e); }
      }}), out));
  });

var rApps = jsonSection('Apps', '/apps',
  function(name){ return { name: name }; },
  ['name','description','icon_url','agent_ids','workflow_ids','dataset_ids','database_ids','plugin_ids'],
  function(m, app) {
    m.appendChild(el('div', { class: 'row' },
      el('button', { class: 'b primary', text: '📦 Publish app version', onclick: function(){
        wapi('POST', '/apps/' + app.id + '/publish').then(function(r){
          toast('✅ v' + r.version + ' — đóng gói ' + JSON.stringify(r.packed));
        }).catch(err);
      }})));
  });

var rPrompts = jsonSection('Prompts', '/prompts',
  function(name){ return { name: name, prompt: '' }; }, ['name','description','prompt']);

function rPlugins() {
  var m = main();
  m.appendChild(el('h2', { text: 'Plugins (HTTP tools)' }));
  var nameIn = el('input', { placeholder: 'Tên plugin' });
  var urlIn = el('input', { placeholder: 'https://api.example.com' });
  m.appendChild(el('div', { class: 'row' }, nameIn, urlIn, el('button', { class: 'b primary', text: 'Tạo', onclick: function(){
    if (nameIn.value.trim() && urlIn.value.trim())
      wapi('POST', '/plugins', { name: nameIn.value.trim(), base_url: urlIn.value.trim() }).then(rPlugins).catch(err);
  }})));
  var specBox = el('textarea', { rows: 4, placeholder: 'Dán OpenAPI 3.x / Swagger 2.x (JSON hoặc YAML), lệnh curl, hoặc Postman collection...' });
  m.appendChild(el('div', { class: 'card' }, specBox,
    el('button', { class: 'b primary', text: 'Import spec/curl/postman', onclick: function(){
      if (!specBox.value.trim()) return;
      wapi('POST', '/plugins/import', { data: specBox.value }).then(function(r){
        toast('✅ Import ' + r.tools_imported + ' tools' + (r.warnings.length ? ' — ' + r.warnings.join('; ') : ''));
        rPlugins();
      }).catch(err);
    }})));
  var box = el('div'); m.appendChild(box);
  wapi('GET', '/plugins').then(function(list){
    list.forEach(function(p){
      var card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'row' }, el('b', { text: p.name }), el('span', { class: 'muted', text: p.base_url }),
        el('a', { class: 'link', text: 'sửa auth/config', onclick: function(){ editPlugin(p.id); } }),
        el('a', { class: 'link', text: 'publish', onclick: function(){
          wapi('POST', '/plugins/' + p.id + '/publish', {}).then(function(r){ toast('✅ Publish v' + r.version); })
            .catch(function(e){
              if (confirm(e.message + '\\nPublish force?')) wapi('POST', '/plugins/' + p.id + '/publish', { force: true }).then(function(r){ toast('✅ Publish v' + r.version); }).catch(err);
            });
        }}),
        el('a', { class: 'link', text: 'xóa', onclick: function(){ if (confirm('Xóa plugin?')) wapi('DELETE', '/plugins/' + p.id).then(rPlugins).catch(err); } })));
      var toolsBox = el('div'); card.appendChild(toolsBox);
      wapi('GET', '/plugins/' + p.id + '/tools').then(function(tools){
        var t = el('table');
        t.appendChild(el('tr', {}, el('th', { text: 'Tool' }), el('th', { text: 'Method' }), el('th', { text: 'Path' }), el('th', { text: 'Debug' }), el('th')));
        tools.forEach(function(tool){
          t.appendChild(el('tr', {}, el('td', { text: tool.name }), el('td', { text: tool.method }), el('td', { text: tool.path }),
            el('td', {}, el('span', { class: 'pill', text: tool.debug_status === 'passed' ? '✓ passed' : 'waiting' })),
            el('td', {}, el('a', { class: 'link', text: 'invoke thử', onclick: function(){
              var args = prompt('args JSON:', '{}'); if (args === null) return;
              wapi('POST', '/plugins/' + p.id + '/tools/' + tool.id + '/invoke', { args: JSON.parse(args) })
                .then(function(r){ alert('HTTP ' + r.status + '\\n' + r.body.slice(0, 1500)); rPlugins(); }).catch(err);
            }}))));
        });
        toolsBox.appendChild(t);
        toolsBox.appendChild(el('button', { class: 'b', text: '+ Tool', onclick: function(){
          var spec = prompt('Tool JSON {name, method, path, description, parameters}:',
            JSON.stringify({ name: 'get_thing', method: 'GET', path: '/things/{id}', description: '', parameters: [ { name: 'id', in: 'path', required: true } ] }));
          if (spec) wapi('POST', '/plugins/' + p.id + '/tools', JSON.parse(spec)).then(rPlugins).catch(err);
        }}));
      }).catch(err);
      box.appendChild(card);
    });
  }).catch(err);
  function editPlugin(id) {
    var m2 = main();
    wapi('GET', '/plugins/' + id).then(function(p){
      m2.appendChild(el('h2', { text: 'Plugin: ' + p.name }));
      var subset = { name: p.name, description: p.description, base_url: p.base_url, auth: p.auth };
      var boxEd = jsonBox(subset, 14);
      m2.appendChild(el('div', { class: 'card' }, boxEd));
      m2.appendChild(el('div', { class: 'muted', text: 'auth: {type:"none"} | {type:"api_key", in:"header|query", name, value} | {type:"oauth2", client_id, client_secret, auth_url, token_url, scopes}' }));
      m2.appendChild(el('div', { class: 'row' },
        el('button', { class: 'b primary', text: 'Lưu', onclick: function(){ try { wapi('PATCH', '/plugins/' + id, readJson(boxEd)).then(function(){ toast('✅'); }).catch(err); } catch (e) { err(e); } } }),
        el('button', { class: 'b', text: 'OAuth connect (user hiện tại)', onclick: function(){
          wapi('GET', '/plugins/' + id + '/oauth/url').then(function(r){ window.open(r.url, '_blank'); }).catch(err);
        }}),
        el('button', { class: 'b', text: '← Danh sách', onclick: rPlugins })));
    }).catch(err);
  }
}

function rDatabases() {
  var m = main();
  m.appendChild(el('h2', { text: 'Databases (memory)' }));
  var nameIn = el('input', { placeholder: 'Tên database' });
  m.appendChild(el('div', { class: 'row' }, nameIn, el('button', { class: 'b primary', text: 'Tạo', onclick: function(){
    if (nameIn.value.trim())
      wapi('POST', '/databases', { name: nameIn.value.trim(), columns: [ { name: 'title', type: 'text', required: true } ] }).then(rDatabases).catch(err);
  }})));
  var file = el('input', { type: 'file', accept: '.xlsx,.csv,.tsv' });
  var impName = el('input', { placeholder: 'Tên DB import' });
  m.appendChild(el('div', { class: 'row' }, impName, file, el('button', { class: 'b', text: 'Import xlsx/csv', onclick: function(){
    var f = file.files[0]; if (!f || !impName.value.trim()) return;
    var rd = new FileReader();
    rd.onload = function(){
      wapi('POST', '/databases/import', { name: impName.value.trim(), filename: f.name, content_base64: rd.result.split(',')[1] })
        .then(function(r){ toast('✅ Import ' + r.inserted + ' rows (skip ' + r.skipped + ')'); rDatabases(); }).catch(err);
    };
    rd.readAsDataURL(f);
  }})));
  var box = el('div'); m.appendChild(box);
  wapi('GET', '/databases').then(function(list){
    list.forEach(function(db){
      var card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'row' }, el('b', { text: db.name }),
        el('span', { class: 'muted', text: (db.columns || []).map(function(c){ return c.name + ':' + c.type; }).join(', ') }),
        el('a', { class: 'link', text: 'rows', onclick: function(){ viewRows(db); } }),
        el('a', { class: 'link', text: 'sửa cột', onclick: function(){
          var cols = prompt('columns JSON:', JSON.stringify(db.columns)); if (cols) wapi('PATCH', '/databases/' + db.id, { columns: JSON.parse(cols) }).then(rDatabases).catch(err);
        }}),
        el('a', { class: 'link', text: 'xóa', onclick: function(){ if (confirm('Xóa DB?')) wapi('DELETE', '/databases/' + db.id).then(rDatabases).catch(err); } })));
      box.appendChild(card);
    });
  }).catch(err);
  function viewRows(db) {
    var m2 = main();
    m2.appendChild(el('h2', { text: 'DB: ' + db.name }));
    var addBox = jsonBox({}, 4);
    m2.appendChild(el('div', { class: 'card' }, el('div', { text: 'Thêm row (JSON theo cột):' }), addBox,
      el('button', { class: 'b primary', text: 'Thêm', onclick: function(){
        try { wapi('POST', '/databases/' + db.id + '/rows', { data: readJson(addBox) }).then(function(){ viewRows(db); }).catch(err); } catch (e) { err(e); }
      }})));
    var listBox = el('div'); m2.appendChild(listBox);
    m2.appendChild(el('button', { class: 'b', text: '← Danh sách', onclick: rDatabases }));
    wapi('POST', '/databases/' + db.id + '/rows/query', { limit: 100 }).then(function(r){
      var t = el('table');
      var cols = (db.columns || []).map(function(c){ return c.name; });
      var head = el('tr'); cols.forEach(function(cn){ head.appendChild(el('th', { text: cn })); }); head.appendChild(el('th'));
      t.appendChild(head);
      r.rows.forEach(function(row){
        var tr = el('tr');
        cols.forEach(function(cn){ tr.appendChild(el('td', { text: String(row.data[cn] == null ? '' : row.data[cn]) })); });
        tr.appendChild(el('td', {}, el('a', { class: 'link', text: 'xóa', onclick: function(){
          wapi('DELETE', '/databases/' + db.id + '/rows/' + row.id).then(function(){ viewRows(db); }).catch(err);
        }})));
        t.appendChild(tr);
      });
      listBox.appendChild(el('div', { class: 'muted', text: r.count + ' rows' }));
      listBox.appendChild(t);
    }).catch(err);
  }
}

function rKeys() {
  var m = main();
  m.appendChild(el('h2', { text: 'API Keys' }));
  var nameIn = el('input', { placeholder: 'Tên key' });
  m.appendChild(el('div', { class: 'row' }, nameIn, el('button', { class: 'b primary', text: 'Tạo', onclick: function(){
    if (!nameIn.value.trim()) return;
    wapi('POST', '/api-keys', { name: nameIn.value.trim() }).then(function(k){
      prompt('Key chỉ hiển thị MỘT lần — copy ngay:', k.key); rKeys();
    }).catch(err);
  }})));
  var box = el('div'); m.appendChild(box);
  wapi('GET', '/api-keys').then(function(list){
    var t = el('table');
    t.appendChild(el('tr', {}, el('th', { text: 'Tên' }), el('th', { text: 'Prefix' }), el('th', { text: 'Dùng lần cuối' }), el('th', { text: 'Trạng thái' }), el('th')));
    list.forEach(function(k){
      t.appendChild(el('tr', {}, el('td', { text: k.name }), el('td', { text: k.prefix + '…' }),
        el('td', { class: 'muted', text: (k.last_used_at || '—').slice(0, 16) }),
        el('td', { text: k.revoked_at ? 'revoked' : 'active' }),
        el('td', {}, k.revoked_at ? null : el('a', { class: 'link', text: 'thu hồi', onclick: function(){ wapi('DELETE', '/api-keys/' + k.id).then(rKeys).catch(err); } }))));
    });
    box.appendChild(t);
  }).catch(err);
}

function rUsage() {
  var m = main();
  m.appendChild(el('h2', { text: 'Usage (30 ngày)' }));
  wapi('GET', '/usage').then(function(u){
    var t = el('table');
    t.appendChild(el('tr', {}, el('th', { text: 'Loại' }), el('th', { text: 'Model' }), el('th', { text: 'Prompt tokens' }), el('th', { text: 'Completion tokens' }), el('th', { text: 'Lượt' })));
    u.totals.forEach(function(r){
      t.appendChild(el('tr', {}, el('td', { text: r.kind }), el('td', { text: r.model }),
        el('td', { text: String(r.prompt_tokens) }), el('td', { text: String(r.completion_tokens) }), el('td', { text: String(r.events) })));
    });
    m.appendChild(t);
  }).catch(err);
}

function rSearch() {
  var m = main();
  m.appendChild(el('h2', { text: 'Tìm resource' }));
  var q = el('input', { placeholder: 'Từ khóa...', style: 'flex:1' });
  var box = el('div');
  m.appendChild(el('div', { class: 'row' }, q, el('button', { class: 'b primary', text: 'Tìm', onclick: run })));
  m.appendChild(box);
  q.addEventListener('keydown', function(e){ if (e.key === 'Enter') run(); });
  function run() {
    wapi('GET', '/search?q=' + encodeURIComponent(q.value)).then(function(r){
      box.innerHTML = '';
      Object.keys(r).forEach(function(kind){
        if (!r[kind].length) return;
        box.appendChild(el('h2', { text: kind }));
        r[kind].forEach(function(x){ box.appendChild(el('div', { class: 'card', text: x.name + (x.description ? ' — ' + x.description : '') })); });
      });
      if (!box.children.length) box.appendChild(el('div', { class: 'muted', text: 'Không có kết quả.' }));
    }).catch(err);
  }
}

function rSettings() {
  var m = main();
  m.appendChild(el('h2', { text: 'Settings' }));
  var tok = el('textarea', { rows: 3, placeholder: 'Supabase access token hoặc czk_ API key', text: S.token });
  m.appendChild(el('div', { class: 'card' }, el('div', { text: 'Bearer token:' }), tok,
    el('button', { class: 'b primary', text: 'Lưu token', onclick: function(){
      S.token = tok.value.trim(); localStorage.setItem('cz-token', S.token);
      loadWorkspaces().then(function(){ toast('✅ Token OK'); go('agents'); }).catch(err);
    }})));
  var su = el('input', { placeholder: 'https://xxxx.supabase.co', style: 'width:100%' });
  var sk = el('input', { placeholder: 'anon key', style: 'width:100%' });
  var em = el('input', { placeholder: 'email' });
  var pw = el('input', { placeholder: 'password', type: 'password' });
  m.appendChild(el('div', { class: 'card' },
    el('div', { text: 'Hoặc đăng nhập qua Supabase Auth (email/password):' }), su, sk,
    el('div', { class: 'row' }, em, pw,
      el('button', { class: 'b', text: 'Đăng nhập', onclick: function(){
        fetch(su.value.replace(/\\/+$/, '') + '/auth/v1/token?grant_type=password', {
          method: 'POST', headers: { 'content-type': 'application/json', apikey: sk.value },
          body: JSON.stringify({ email: em.value, password: pw.value })
        }).then(function(r){ return r.json(); }).then(function(j){
          if (!j.access_token) throw new Error(j.error_description || j.msg || 'login failed');
          S.token = j.access_token; localStorage.setItem('cz-token', S.token);
          loadWorkspaces().then(function(){ toast('✅ Đã đăng nhập'); go('agents'); });
        }).catch(err);
      }}))));
}

buildNav();
if (S.token) { loadWorkspaces().then(function(){ go('agents'); }).catch(function(){ go('settings'); }); }
else go('settings');
</script>
</body>
</html>`
