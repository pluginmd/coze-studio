// Main console application logic (vanilla JS, no build step). Relies on the
// helpers defined in clientlib.ts. No template literals inside.
export const appJs = `
/* ================= navigation ================= */
var VIEWS = [
  ['home', '🏠', 'Tổng quan'], ['agents', '🤖', 'Agents'], ['chat', '💬', 'Chat'],
  ['knowledge', '📚', 'Knowledge'], ['workflows', '🔀', 'Workflows'], ['plugins', '🔌', 'Plugins'],
  ['databases', '🗄️', 'Databases'], ['apps', '📦', 'Apps'], ['prompts', '📝', 'Prompts'],
  ['keys', '🔑', 'API Keys'], ['usage', '📊', 'Usage'], ['search', '🔍', 'Tìm kiếm'], ['settings', '⚙️', 'Cài đặt']
];
var RENDER = {};

function buildNav() {
  var side = document.getElementById('side');
  side.appendChild(el('div', { class: 'brand' }, el('span', { class: 'dot', text: '⚡' }), 'Coze Port'));
  var sel = el('select', { id: 'wsel' });
  side.appendChild(sel);
  VIEWS.forEach(function(v){
    if (v[0] === 'settings') side.appendChild(el('div', { class: 'sep' }));
    side.appendChild(el('button', { class: 'nav', id: 'nav-' + v[0], onclick: function(){ go(v[0]); } },
      el('span', { class: 'ic', text: v[1] }), v[2]));
  });
  side.appendChild(el('div', { class: 'foot' },
    el('button', { class: 'btn sm', text: '🌓 Giao diện', onclick: toggleTheme })));
}
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('cz-theme', next);
}
if (localStorage.getItem('cz-theme')) document.documentElement.setAttribute('data-theme', localStorage.getItem('cz-theme'));

function go(view) {
  S.view = view; localStorage.setItem('cz-view', view);
  VIEWS.forEach(function(v){ var b = document.getElementById('nav-' + v[0]); if (b) b.classList.toggle('active', v[0] === view); });
  document.getElementById('side').classList.remove('open');
  (RENDER[view] || RENDER.home)();
}
function pagehead(m, title, actions) {
  var h = el('div', { class: 'pagehead' }, el('h1', { text: title }), el('span', { class: 'spacer' }));
  (actions || []).forEach(function(a){ h.appendChild(a); });
  m.appendChild(h);
  return h;
}
function loadWorkspaces() {
  return api('GET', '/workspaces').then(function(list){
    var sel = document.getElementById('wsel'); sel.innerHTML = '';
    list.forEach(function(w){ sel.appendChild(el('option', { value: w.id, text: w.name })); });
    sel.appendChild(el('option', { value: '__new', text: '+ Tạo workspace…' }));
    if (!S.wid || !list.some(function(w){ return w.id === S.wid; })) S.wid = list.length ? list[0].id : '';
    sel.value = S.wid; localStorage.setItem('cz-wid', S.wid);
    sel.onchange = function(){
      if (sel.value === '__new') {
        promptM('Tên workspace mới').then(function(name){
          if (!name) { sel.value = S.wid; return; }
          api('POST', '/workspaces', { name: name }).then(function(w){ S.wid = w.id; loadWorkspaces().then(function(){ go(S.view); }); }).catch(err);
        });
      } else { S.wid = sel.value; localStorage.setItem('cz-wid', S.wid); go(S.view); }
    };
  });
}

/* ================= home dashboard ================= */
RENDER.home = function() {
  var m = main();
  pagehead(m, 'Tổng quan');
  var stats = el('div', { class: 'grid cols4' });
  m.appendChild(stats);
  var defs = [['agents', '🤖', 'Agents'], ['datasets', '📚', 'Knowledge'], ['workflows', '🔀', 'Workflows'], ['plugins', '🔌', 'Plugins']];
  defs.forEach(function(d){ stats.appendChild(el('div', { class: 'card stat', id: 'st-' + d[0] }, el('div', { class: 'skl', style: 'width:40px;height:24px' }), el('div', { class: 'l', text: d[1] + ' ' + d[2] }))); });
  defs.forEach(function(d){
    wapi('GET', '/' + d[0]).then(function(list){
      var c = document.getElementById('st-' + d[0]); if (!c) return;
      c.innerHTML = '';
      c.appendChild(el('div', { class: 'n', text: String(list.length) }));
      c.appendChild(el('div', { class: 'l', text: d[1] + ' ' + d[2] }));
      c.style.cursor = 'pointer'; c.onclick = function(){ go(d[0]); };
    }).catch(function(){});
  });
  var recentCard = el('div', { class: 'card', style: 'margin-top:14px' }, el('div', { class: 'row' }, el('b', { text: 'Agents gần đây' }), el('span', { class: 'spacer' }), el('button', { class: 'btn sm primary', text: '+ Tạo agent', onclick: function(){ createAgentFlow(); } })));
  var recentBox = el('div'); recentCard.appendChild(recentBox);
  m.appendChild(recentCard);
  wapi('GET', '/agents').then(function(list){
    if (!list.length) { recentBox.appendChild(el('div', { class: 'empty' }, el('div', { class: 'big', text: '🤖' }), el('div', { text: 'Chưa có agent nào — tạo cái đầu tiên hoặc cài template.' }))); return; }
    var t = el('table', { class: 't' });
    list.slice(0, 6).forEach(function(a){
      t.appendChild(el('tr', { class: 'click', onclick: function(){ editAgent(a.id); } },
        el('td', {}, el('b', { text: a.name })),
        el('td', {}, el('span', { class: 'badge ' + (a.status === 'published' ? 'ok' : 'mut'), text: a.status })),
        el('td', { class: 'sub', text: fmtDate(a.updated_at) })));
    });
    recentBox.appendChild(t);
  }).catch(err);
  var tplCard = el('div', { class: 'card', style: 'margin-top:14px' }, el('b', { text: '🚀 Bắt đầu nhanh với template' }));
  var tplRow = el('div', { class: 'row', style: 'margin-top:10px' });
  tplCard.appendChild(tplRow); m.appendChild(tplCard);
  wapi('GET', '/templates').then(function(list){
    list.forEach(function(t){
      tplRow.appendChild(el('button', { class: 'chip', text: t.name, title: t.description, onclick: function(){
        wapi('POST', '/templates/' + t.id + '/install').then(function(r){ toast('✅ Đã cài ' + t.name, 'ok'); go('home'); }).catch(err);
      }}));
    });
  }).catch(function(){});
};

/* ================= agents ================= */
function createAgentFlow() {
  promptM('Tên agent mới').then(function(name){
    if (!name) return;
    wapi('POST', '/agents', { name: name, prompt: 'Bạn là một trợ lý hữu ích.' }).then(function(a){ editAgent(a.id); }).catch(err);
  });
}
RENDER.agents = function() {
  var m = main();
  pagehead(m, 'Agents', [el('button', { class: 'btn primary', text: '+ Tạo agent', onclick: createAgentFlow })]);
  var grid = el('div', { class: 'grid cols3' });
  m.appendChild(grid);
  grid.appendChild(el('div', { class: 'card skl', style: 'height:90px' }));
  wapi('GET', '/agents').then(function(list){
    grid.innerHTML = '';
    if (!list.length) { grid.appendChild(el('div', { class: 'empty card' }, el('div', { class: 'big', text: '🤖' }), el('div', { text: 'Chưa có agent.' }))); return; }
    list.forEach(function(a){
      grid.appendChild(el('div', { class: 'card', style: 'cursor:pointer', onclick: function(){ editAgent(a.id); } },
        el('div', { class: 'row' }, el('b', { text: a.name }), el('span', { class: 'spacer' }), el('span', { class: 'badge ' + (a.status === 'published' ? 'ok' : 'mut'), text: a.status })),
        el('div', { class: 'sub', style: 'margin-top:6px', text: (a.description || 'Chưa có mô tả') }),
        el('div', { class: 'sub', style: 'margin-top:8px', text: 'Cập nhật ' + fmtDate(a.updated_at) })));
    });
  }).catch(err);
};

var AGENT_TABS = ['Persona', 'Model', 'Kỹ năng', 'Trải nghiệm', 'Nâng cao'];
function field(labelText, input, hint) {
  var l = el('label', { class: 'f' }, el('span', { text: labelText }), input);
  if (hint) l.appendChild(el('div', { class: 'hint', text: hint }));
  return l;
}
function numInput(v, step) { return el('input', { type: 'number', step: step || 'any', value: v == null ? '' : v }); }
function selInput(v, options) {
  var s = el('select');
  options.forEach(function(o){ s.appendChild(el('option', { value: o[0], text: o[1] })); });
  s.value = v == null ? options[0][0] : String(v);
  return s;
}
function listEditor(items, placeholder) {
  var box = el('div');
  var list = el('div'); box.appendChild(list);
  function render() {
    list.innerHTML = '';
    items.forEach(function(it, i){
      var inp = el('input', { value: it, style: 'flex:1', oninput: function(){ items[i] = inp.value; } });
      list.appendChild(el('div', { class: 'row', style: 'margin-top:6px' }, inp,
        el('button', { class: 'btn sm danger', text: '✕', onclick: function(){ items.splice(i, 1); render(); } })));
    });
  }
  render();
  box.appendChild(el('button', { class: 'btn sm', style: 'margin-top:8px', text: '+ Thêm', onclick: function(){ items.push(placeholder || ''); render(); } }));
  box.getItems = function(){ return items.filter(function(x){ return String(x).trim(); }); };
  return box;
}
function multiPick(endpoint, selectedIds, labelKey) {
  var box = el('div', { style: 'max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px' });
  var set = {};
  (selectedIds || []).forEach(function(id){ set[id] = true; });
  box.appendChild(el('div', { class: 'skl', style: 'height:16px' }));
  wapi('GET', endpoint).then(function(list){
    box.innerHTML = '';
    if (!list.length) { box.appendChild(el('div', { class: 'sub', text: 'Trống — tạo trước ở mục tương ứng.' })); return; }
    list.forEach(function(it){
      var cb = el('input', { type: 'checkbox', onchange: function(){ if (cb.checked) set[it.id] = true; else delete set[it.id]; } });
      cb.checked = !!set[it.id];
      box.appendChild(el('label', { style: 'display:flex;gap:8px;align-items:center;padding:3px 2px;cursor:pointer' }, cb, el('span', { text: it[labelKey || 'name'] })));
    });
  }).catch(function(){ box.innerHTML = ''; box.appendChild(el('div', { class: 'sub', text: 'Không tải được.' })); });
  box.getIds = function(){ return Object.keys(set); };
  return box;
}

function editAgent(id) {
  var m = main();
  wapi('GET', '/agents/' + id).then(function(a){
    var draft = JSON.parse(JSON.stringify(a));
    var head = pagehead(m, a.name, [
      el('button', { class: 'btn primary', text: '💾 Lưu', onclick: save }),
      el('button', { class: 'btn', text: '💬 Chat thử', onclick: function(){ S.chatAgent = a.id; go('chat'); } }),
      el('button', { class: 'btn', text: '📦 Publish', onclick: function(){ wapi('POST', '/agents/' + id + '/publish').then(function(r){ toast('✅ Publish v' + r.version, 'ok'); }).catch(err); } }),
      el('button', { class: 'btn', text: '🔗 Share', onclick: function(){
        wapi('POST', '/agents/' + id + '/share').then(function(r){
          modal({ title: 'Public chat URL', body: el('input', { value: r.url, style: 'width:100%', onclick: function(ev){ ev.target.select(); } }), actions: [{ label: 'Đóng', value: true }] });
        }).catch(err);
      }}),
      el('button', { class: 'btn', text: '⧉', title: 'Nhân bản', onclick: function(){ wapi('POST', '/agents/' + id + '/duplicate').then(function(r){ toast('✅ Đã nhân bản', 'ok'); editAgent(r.id); }).catch(err); } }),
      el('button', { class: 'btn danger', text: '🗑', onclick: function(){ confirmM('Xóa agent "' + a.name + '"?', true).then(function(ok){ if (ok) wapi('DELETE', '/agents/' + id).then(function(){ go('agents'); }).catch(err); }); } }),
      el('button', { class: 'btn', text: '←', onclick: function(){ go('agents'); } })
    ]);
    if (a.share_token) head.appendChild(el('div', { class: 'sub', style: 'width:100%', text: 'Share: ' + location.origin + '/share/' + a.share_token }));

    var tabs = el('div', { class: 'tabs' });
    var body = el('div');
    m.appendChild(tabs); m.appendChild(body);
    var panes = {};
    AGENT_TABS.forEach(function(name, i){
      var b = el('button', { text: name, onclick: function(){ show(name); } });
      tabs.appendChild(b); panes[name] = { btn: b };
    });
    function show(name) {
      AGENT_TABS.forEach(function(n){ panes[n].btn.classList.toggle('on', n === name); });
      body.innerHTML = ''; body.appendChild(build(name));
    }

    /* form controls (kept as references so save() can read them) */
    var C = {};
    function build(name) {
      var card = el('div', { class: 'card' });
      if (name === 'Persona') {
        C.name = el('input', { value: draft.name });
        C.description = el('input', { value: draft.description || '' });
        C.prompt = el('textarea', { rows: 14 }); C.prompt.value = draft.prompt || '';
        card.appendChild(field('Tên', C.name));
        card.appendChild(field('Mô tả', C.description));
        card.appendChild(field('System prompt (persona)', C.prompt, 'Hỗ trợ biến: {{var.x}} và {{sys.time}}, {{sys.date}}, {{sys.user_key}}, {{sys.agent_name}}'));
      }
      if (name === 'Model') {
        var mc = draft.model || {};
        C.model = el('input', { value: mc.model || '', placeholder: 'gpt-4o-mini (mặc định theo env)' });
        C.temperature = numInput(mc.temperature, '0.1');
        C.max_tokens = numInput(mc.max_tokens, '1');
        C.top_p = numInput(mc.top_p, '0.05');
        C.frequency_penalty = numInput(mc.frequency_penalty, '0.1');
        C.presence_penalty = numInput(mc.presence_penalty, '0.1');
        C.response_format = selInput(mc.response_format || 'text', [['text', 'Text'], ['json', 'JSON mode']]);
        C.history_rounds = numInput(mc.history_rounds, '1');
        card.appendChild(field('Model', C.model));
        var g = el('div', { class: 'grid cols3' });
        g.appendChild(field('Temperature', C.temperature));
        g.appendChild(field('Max tokens', C.max_tokens));
        g.appendChild(field('Top P', C.top_p));
        g.appendChild(field('Frequency penalty', C.frequency_penalty));
        g.appendChild(field('Presence penalty', C.presence_penalty));
        g.appendChild(field('Số lượt hội thoại nhớ', C.history_rounds));
        card.appendChild(g);
        card.appendChild(field('Định dạng trả lời', C.response_format));
      }
      if (name === 'Kỹ năng') {
        C.datasets = multiPick('/datasets', draft.dataset_ids);
        C.workflows = multiPick('/workflows', draft.workflow_ids);
        C.databases = multiPick('/databases', draft.database_ids);
        C.tools = el('div', { style: 'max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px' });
        var toolSet = {};
        (draft.plugin_tool_ids || []).forEach(function(tid){ toolSet[tid] = true; });
        wapi('GET', '/plugins').then(function(ps){
          C.tools.innerHTML = '';
          if (!ps.length) { C.tools.appendChild(el('div', { class: 'sub', text: 'Chưa có plugin.' })); return; }
          ps.forEach(function(p){
            var head2 = el('div', { style: 'font-weight:600;margin-top:6px', text: '🔌 ' + p.name });
            C.tools.appendChild(head2);
            wapi('GET', '/plugins/' + p.id + '/tools').then(function(ts){
              ts.forEach(function(t){
                var cb = el('input', { type: 'checkbox', onchange: function(){ if (cb.checked) toolSet[t.id] = true; else delete toolSet[t.id]; } });
                cb.checked = !!toolSet[t.id];
                head2.after(el('label', { style: 'display:flex;gap:8px;align-items:center;padding:2px 10px;cursor:pointer' }, cb, el('span', { text: t.name })));
              });
            });
          });
        });
        C.tools.getIds = function(){ return Object.keys(toolSet); };
        var kb = draft.knowledge || {};
        C.kb_top_k = numInput(kb.top_k, '1');
        C.kb_min_score = numInput(kb.min_score, '0.05');
        C.kb_search = selInput(kb.search_type || 'hybrid', [['hybrid', 'Hybrid (vector+keyword)'], ['semantic', 'Semantic'], ['fulltext', 'Full-text']]);
        C.kb_auto = selInput(kb.auto === false ? 'tool' : 'auto', [['auto', 'Tự động mỗi lượt'], ['tool', 'On-demand (agent tự gọi tool)']]);
        C.kb_rerank = selInput(kb.rerank ? '1' : '0', [['0', 'Tắt'], ['1', 'Bật (Jina reranker)']]);
        card.appendChild(field('📚 Knowledge bases', C.datasets));
        var kg = el('div', { class: 'grid cols3', style: 'margin-top:4px' });
        kg.appendChild(field('Top K', C.kb_top_k));
        kg.appendChild(field('Min score', C.kb_min_score));
        kg.appendChild(field('Kiểu tìm', C.kb_search));
        kg.appendChild(field('Chế độ recall', C.kb_auto));
        kg.appendChild(field('Rerank', C.kb_rerank));
        card.appendChild(kg);
        card.appendChild(field('🔧 Plugin tools', C.tools));
        card.appendChild(field('🔀 Workflows (thành tool)', C.workflows));
        card.appendChild(field('🗄️ Databases (memory)', C.databases));
      }
      if (name === 'Trải nghiệm') {
        C.welcome = el('textarea', { rows: 3 }); C.welcome.value = draft.welcome_message || '';
        C.questions = listEditor((draft.suggested_questions || []).slice(), 'Câu hỏi gợi ý…');
        var sr = draft.suggest_reply || {};
        C.sr_mode = selInput(sr.mode || 'off', [['off', 'Tắt'], ['auto', 'Tự sinh 3 gợi ý'], ['custom', 'Prompt tùy chỉnh']]);
        C.sr_prompt = el('textarea', { rows: 3 }); C.sr_prompt.value = sr.prompt || '';
        var ob = draft.onboarding || {};
        C.ob_mode = selInput(ob.mode || 'manual', [['manual', 'Thủ công (dùng welcome)'], ['llm', 'LLM tự sinh lời chào']]);
        C.ob_prompt = el('textarea', { rows: 3 }); C.ob_prompt.value = ob.prompt || '';
        card.appendChild(field('Lời chào (welcome)', C.welcome));
        card.appendChild(field('Câu hỏi gợi ý mở đầu', C.questions));
        card.appendChild(field('Follow-up suggestions', C.sr_mode));
        card.appendChild(field('Prompt gợi ý (mode custom)', C.sr_prompt));
        card.appendChild(field('Onboarding', C.ob_mode));
        card.appendChild(field('Prompt onboarding (mode llm)', C.ob_prompt));
      }
      if (name === 'Nâng cao') {
        C.variables = el('textarea', { rows: 5, class: 'mono' }); C.variables.value = JSON.stringify(draft.variables || {}, null, 2);
        C.shortcuts = el('textarea', { rows: 7, class: 'mono' }); C.shortcuts.value = JSON.stringify(draft.shortcuts || [], null, 2);
        C.multi_agent = el('textarea', { rows: 6, class: 'mono' }); C.multi_agent.value = JSON.stringify(draft.multi_agent || {}, null, 2);
        card.appendChild(field('Variables (JSON)', C.variables, 'Dùng trong prompt qua {{var.x}}'));
        card.appendChild(field('Shortcut commands (JSON)', C.shortcuts, '[{"command":"/dich","template":"Dịch sang {{lang}}: {{text}}","components":[{"name":"text"},{"name":"lang"}],"workflow_id":null}]'));
        card.appendChild(field('Multi-agent (JSON)', C.multi_agent, '{"enabled":true,"sub_agents":[{"agent_id":"…","description":"chuyên về …"}]}'));
      }
      return card;
    }
    function save() {
      try {
        var patch = {};
        if (C.name) { patch.name = C.name.value; patch.description = C.description.value; patch.prompt = C.prompt.value; }
        if (C.model) {
          var mc = {};
          if (C.model.value.trim()) mc.model = C.model.value.trim();
          ['temperature', 'max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty', 'history_rounds'].forEach(function(k){
            if (C[k] && C[k].value !== '') mc[k] = Number(C[k].value);
          });
          if (C.response_format.value !== 'text') mc.response_format = C.response_format.value;
          patch.model = mc;
        }
        if (C.datasets) {
          patch.dataset_ids = C.datasets.getIds();
          patch.workflow_ids = C.workflows.getIds();
          patch.database_ids = C.databases.getIds();
          patch.plugin_tool_ids = C.tools.getIds();
          var kb = {};
          if (C.kb_top_k.value !== '') kb.top_k = Number(C.kb_top_k.value);
          if (C.kb_min_score.value !== '') kb.min_score = Number(C.kb_min_score.value);
          kb.search_type = C.kb_search.value;
          if (C.kb_auto.value === 'tool') kb.auto = false;
          if (C.kb_rerank.value === '1') kb.rerank = true;
          patch.knowledge = kb;
        }
        if (C.welcome) {
          patch.welcome_message = C.welcome.value;
          patch.suggested_questions = C.questions.getItems();
          patch.suggest_reply = { mode: C.sr_mode.value, prompt: C.sr_prompt.value };
          patch.onboarding = { mode: C.ob_mode.value, prompt: C.ob_prompt.value };
        }
        if (C.variables) {
          patch.variables = JSON.parse(C.variables.value || '{}');
          patch.shortcuts = JSON.parse(C.shortcuts.value || '[]');
          patch.multi_agent = JSON.parse(C.multi_agent.value || '{}');
        }
        wapi('PATCH', '/agents/' + id, patch).then(function(updated){
          draft = JSON.parse(JSON.stringify(updated));
          toast('✅ Đã lưu', 'ok');
        }).catch(err);
      } catch (e) { err(e); }
    }
    show('Persona');
  }).catch(err);
}

/* ================= chat ================= */
RENDER.chat = function() {
  var m = main();
  var sel = el('select', { style: 'min-width:180px' });
  var attach = [];
  pagehead(m, 'Chat', [sel,
    el('button', { class: 'btn', text: '🆕 Hội thoại mới', onclick: function(){ S.chatConv = null; log.innerHTML = ''; sq.innerHTML = ''; } })]);
  var wrap = el('div', { class: 'chatwrap' });
  var log = el('div', { id: 'chatlog' });
  var sq = el('div', { class: 'row' });
  var attRow = el('div', { class: 'attachrow' });
  var input = el('textarea', { rows: 1, placeholder: 'Nhập tin nhắn… (Enter gửi, Shift+Enter xuống dòng)' });
  var fileIn = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  var stopBtn = el('button', { class: 'btn', text: '⏹', title: 'Dừng', onclick: function(){ if (S.chatAbort) S.chatAbort.abort(); } });
  var bar = el('div', { class: 'chatbar' },
    el('button', { class: 'btn', text: '🖼', title: 'Đính kèm ảnh', onclick: function(){ fileIn.click(); } }),
    input,
    el('button', { class: 'btn primary', text: 'Gửi ➤', onclick: function(){ send(input.value); } }), stopBtn);
  wrap.appendChild(log); wrap.appendChild(sq); wrap.appendChild(attRow); wrap.appendChild(bar);
  m.appendChild(wrap); m.appendChild(fileIn);

  fileIn.onchange = function(){
    var f = fileIn.files[0]; if (!f) return;
    fileToB64(f).then(function(b64){
      var a = { type: 'image', base64: b64, mime: f.type };
      attach.push(a);
      var img = el('img', { src: 'data:' + f.type + ';base64,' + b64 });
      var wrap2 = el('div', { class: 'att' }, img, el('button', { class: 'x', text: '✕', onclick: function(){ attach.splice(attach.indexOf(a), 1); wrap2.remove(); } }));
      attRow.appendChild(wrap2);
    });
    fileIn.value = '';
  };
  input.addEventListener('keydown', function(ev){ if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(input.value); } });
  wapi('GET', '/agents').then(function(list){
    list.forEach(function(a){ sel.appendChild(el('option', { value: a.id, text: a.name })); });
    if (S.chatAgent) sel.value = S.chatAgent;
    sel.onchange = function(){ S.chatAgent = sel.value; };
    if (sel.value) S.chatAgent = sel.value;
  }).catch(err);

  function bubble(role, raw) {
    var bub = el('div', { class: 'bub' });
    var msg = el('div', { class: 'msg ' + (role === 'user' ? 'user' : 'ai') },
      el('div', { class: 'av', text: role === 'user' ? '🧑' : '🤖' }), bub);
    log.appendChild(msg); log.scrollTop = log.scrollHeight;
    return { root: msg, bub: bub, setMd: function(text, streaming){
      bub.innerHTML = '<div class="md">' + md(text) + (streaming ? '<span class="cursor"></span>' : '') + '</div>';
      log.scrollTop = log.scrollHeight;
    } };
  }
  function showSuggestions(list) {
    sq.innerHTML = '';
    (list || []).forEach(function(q){ sq.appendChild(el('button', { class: 'chip', text: q, onclick: function(){ send(q); } })); });
  }
  function send(text) {
    text = (text || '').trim();
    if (!text || !sel.value) return;
    input.value = ''; showSuggestions([]);
    var u = bubble('user', text); u.setMd(text);
    if (attach.length) u.bub.appendChild(el('div', { class: 'toolinfo', text: '🖼 ' + attach.length + ' ảnh đính kèm' }));
    var payloadAttach = attach.slice(); attach.length = 0; attRow.innerHTML = '';
    var a = bubble('ai', ''); a.setMd('', true);
    var raw = '';
    S.chatAbort = new AbortController();
    fetch('/v1/workspaces/' + S.wid + '/chat', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + S.token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: sel.value, conversation_id: S.chatConv || null, message: text, attachments: payloadAttach }),
      signal: S.chatAbort.signal
    }).then(function(res){
      if (!res.ok) return res.text().then(function(t){ a.setMd('❌ ' + t); });
      return readSSE(res, function(event, data){
        if (event === 'start') S.chatConv = data.conversation_id;
        else if (event === 'delta') { raw += data.content; a.setMd(raw, true); }
        else if (event === 'shortcut') a.bub.appendChild(el('div', { class: 'toolinfo', text: '⚡ shortcut ' + data.command }));
        else if (event === 'route') a.bub.appendChild(el('div', { class: 'toolinfo', text: '🔀 chuyển cho agent: ' + data.name }));
        else if (event === 'tool_call') {
          var d = el('details', {}, el('summary', { text: '🔧 ' + data.name }), el('div', { class: 'sub', text: JSON.stringify(data.args) }));
          a.bub.appendChild(d);
        }
        else if (event === 'tool_result') {
          var last = a.bub.querySelector('details:last-of-type');
          if (last) last.appendChild(el('div', { class: 'sub', text: '→ ' + String(data.output).slice(0, 400) }));
        }
        else if (event === 'suggestion') showSuggestions(data.suggestions);
        else if (event === 'done') { a.setMd(raw || '(trống)'); if (data.suggestions) showSuggestions(data.suggestions); }
        else if (event === 'error') a.setMd(raw + '\\n\\n❌ ' + data.error);
      }).then(function(){ a.setMd(raw || '(trống)'); });
    }).catch(function(){ a.setMd(raw + '\\n\\n⏹ đã dừng (phần dở lưu là broken)'); });
  }
};

/* ================= knowledge ================= */
RENDER.knowledge = function() {
  var m = main();
  pagehead(m, 'Knowledge', [el('button', { class: 'btn primary', text: '+ Dataset', onclick: function(){
    promptM('Tên dataset').then(function(name){ if (name) wapi('POST', '/datasets', { name: name }).then(RENDER.knowledge).catch(err); });
  }})]);
  var box = el('div', { class: 'grid', style: 'grid-template-columns:1fr' });
  m.appendChild(box);
  wapi('GET', '/datasets').then(function(list){
    if (!list.length) { box.appendChild(el('div', { class: 'empty card' }, el('div', { class: 'big', text: '📚' }), el('div', { text: 'Chưa có knowledge base.' }))); return; }
    list.forEach(function(ds){ box.appendChild(datasetCard(ds)); });
  }).catch(err);

  function datasetCard(ds) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'row' },
      el('b', { text: '📚 ' + ds.name }),
      el('span', { class: 'sub', text: ds.description || '' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', text: '🔎 Test search', onclick: function(){ searchModal(ds); } }),
      el('button', { class: 'btn sm danger', text: 'Xóa', onclick: function(){ confirmM('Xóa dataset "' + ds.name + '"?', true).then(function(ok){ if (ok) wapi('DELETE', '/datasets/' + ds.id).then(RENDER.knowledge).catch(err); }); } })));
    var drop = el('div', { style: 'border:2px dashed var(--border);border-radius:10px;padding:16px;text-align:center;color:var(--muted);margin:12px 0;cursor:pointer' },
      '📄 Kéo thả hoặc bấm để upload (pdf, docx, xlsx, ảnh, txt, md, csv…)');
    var fi = el('input', { type: 'file', style: 'display:none', multiple: 'multiple' });
    drop.onclick = function(){ fi.click(); };
    drop.ondragover = function(ev){ ev.preventDefault(); drop.style.borderColor = 'var(--primary)'; };
    drop.ondragleave = function(){ drop.style.borderColor = 'var(--border)'; };
    drop.ondrop = function(ev){ ev.preventDefault(); drop.style.borderColor = 'var(--border)'; uploadFiles(ev.dataTransfer.files); };
    fi.onchange = function(){ uploadFiles(fi.files); fi.value = ''; };
    function uploadFiles(files) {
      Array.prototype.forEach.call(files, function(f){
        fileToB64(f).then(function(b64){
          return wapi('POST', '/datasets/' + ds.id + '/documents', { name: f.name, content_base64: b64 });
        }).then(function(r){ toast('⏳ Đang index ' + f.name + ' (' + (r.indexing_via || '') + ')'); poll(); }).catch(err);
      });
    }
    card.appendChild(drop); card.appendChild(fi);
    var docsBox = el('div'); card.appendChild(docsBox);
    var pollTimer = null;
    function poll() {
      loadDocs().then(function(pending){
        if (pending && !pollTimer) pollTimer = setInterval(function(){ loadDocs().then(function(p){ if (!p) { clearInterval(pollTimer); pollTimer = null; } }); }, 2500);
      });
    }
    function loadDocs() {
      return wapi('GET', '/datasets/' + ds.id + '/documents').then(function(docs){
        docsBox.innerHTML = '';
        if (!docs.length) return false;
        var t = el('table', { class: 't' });
        t.appendChild(el('tr', {}, el('th', { text: 'Tài liệu' }), el('th', { text: 'Trạng thái' }), el('th', { text: 'Chunks' }), el('th')));
        var pending = false;
        docs.forEach(function(d){
          if (d.status === 'pending' || d.status === 'processing') pending = true;
          var badge = d.status === 'ready' ? 'ok' : d.status === 'failed' ? 'err' : 'warn';
          t.appendChild(el('tr', {},
            el('td', {}, el('b', { text: d.name })),
            el('td', {}, el('span', { class: 'badge ' + badge, text: d.status }), d.error ? el('div', { class: 'sub', text: String(d.error).slice(0, 90) }) : ''),
            el('td', { text: String(d.chunk_count) }),
            el('td', {}, el('div', { class: 'row' },
              el('button', { class: 'btn sm', text: 'Chunks', onclick: function(){ viewChunks(ds.id, d.id, d.name); } }),
              el('button', { class: 'btn sm', text: '↻', title: 'Reindex', onclick: function(){ wapi('POST', '/datasets/' + ds.id + '/documents/' + d.id + '/reindex').then(function(){ toast('⏳ reindex'); poll(); }).catch(err); } }),
              el('button', { class: 'btn sm danger', text: '✕', onclick: function(){ confirmM('Xóa "' + d.name + '"?', true).then(function(ok){ if (ok) wapi('DELETE', '/datasets/' + ds.id + '/documents/' + d.id).then(loadDocs).catch(err); }); } })))));
        });
        docsBox.appendChild(t);
        return pending;
      }).catch(function(){ return false; });
    }
    poll();
    return card;
  }
  function searchModal(ds) {
    var q = el('input', { style: 'width:100%', placeholder: 'Câu hỏi thử…' });
    var res = el('div', { style: 'margin-top:10px' });
    var body = el('div', {}, q, res);
    function run() {
      res.innerHTML = ''; res.appendChild(el('div', { class: 'skl', style: 'height:40px' }));
      wapi('POST', '/datasets/' + ds.id + '/search', { query: q.value }).then(function(chunks){
        res.innerHTML = '';
        if (!chunks.length) { res.appendChild(el('div', { class: 'sub', text: 'Không có kết quả.' })); return; }
        chunks.forEach(function(ch){
          res.appendChild(el('div', { class: 'card', style: 'margin-top:8px;padding:10px' },
            el('span', { class: 'badge info', text: ch.score.toFixed(3) }), ' ',
            el('span', { text: ch.content.slice(0, 260) })));
        });
      }).catch(err);
    }
    q.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') run(); });
    modal({ title: '🔎 Test retrieval — ' + ds.name, body: body, wide: true, actions: [{ label: 'Tìm', primary: true, value: function(){ run(); return undefined; } }, { label: 'Đóng', value: null }] });
  }
};
function viewChunks(dsid, docid, docName) {
  var m = main();
  pagehead(m, 'Chunks — ' + docName, [
    el('button', { class: 'btn primary', text: '+ Chunk', onclick: function(){
      promptM('Nội dung chunk mới (sẽ embed ngay)', '', true).then(function(v){
        if (v) wapi('POST', '/datasets/' + dsid + '/documents/' + docid + '/chunks', { content: v }).then(function(){ viewChunks(dsid, docid, docName); }).catch(err);
      });
    }}),
    el('button', { class: 'btn', text: '←', onclick: function(){ go('knowledge'); } })]);
  var box = el('div', { class: 'grid', style: 'grid-template-columns:1fr' });
  m.appendChild(box);
  wapi('GET', '/datasets/' + dsid + '/documents/' + docid + '/chunks?limit=100').then(function(chunks){
    if (!chunks.length) { box.appendChild(el('div', { class: 'empty card', text: 'Chưa có chunk.' })); return; }
    chunks.forEach(function(ch){
      var card = el('div', { class: 'card', style: ch.enabled ? '' : 'opacity:.5' });
      card.appendChild(el('div', { class: 'row' },
        el('span', { class: 'badge mut', text: '#' + ch.seq }),
        ch.enabled ? '' : el('span', { class: 'badge warn', text: 'disabled' }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn sm', text: ch.enabled ? 'Disable' : 'Enable', onclick: function(){ wapi('PATCH', '/datasets/' + dsid + '/chunks/' + ch.id, { enabled: !ch.enabled }).then(function(){ viewChunks(dsid, docid, docName); }).catch(err); } }),
        el('button', { class: 'btn sm', text: 'Sửa', onclick: function(){
          promptM('Nội dung (re-embed)', ch.content, true).then(function(v){ if (v != null && v !== '') wapi('PATCH', '/datasets/' + dsid + '/chunks/' + ch.id, { content: v }).then(function(){ viewChunks(dsid, docid, docName); }).catch(err); });
        }}),
        el('button', { class: 'btn sm danger', text: '✕', onclick: function(){ confirmM('Xóa chunk?', true).then(function(ok){ if (ok) wapi('DELETE', '/datasets/' + dsid + '/chunks/' + ch.id).then(function(){ viewChunks(dsid, docid, docName); }).catch(err); }); } })));
      card.appendChild(el('div', { style: 'margin-top:8px;white-space:pre-wrap;font-size:13px', text: ch.content.slice(0, 500) }));
      box.appendChild(card);
    });
  }).catch(err);
}
`
