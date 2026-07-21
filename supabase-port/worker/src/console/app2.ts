// Console app part 2: workflows (pro canvas), plugins, databases, apps,
// prompts, keys, usage, search, settings + boot.
export const appJs2 = `
/* ================= workflows ================= */
var NODE_TYPES = ['start','end','llm','intent','knowledge_retrieve','knowledge_index','knowledge_delete','plugin','http','database_query','database_insert','database_update','database_delete','condition','selector','loop','batch','sub_workflow','question','input','variable_assign','output_emitter','conversation_create','conversation_update','conversation_delete','conversation_list','conversation_clear','message_create','message_edit','message_delete','message_list','template','code','text_processor','json_parse','json_stringify','variable_aggregator'];
var NODE_COLOR = { start: '#059669', end: '#059669', llm: '#6366f1', intent: '#6366f1', question: '#f59e0b', input: '#f59e0b', output_emitter: '#f59e0b', condition: '#0ea5e9', selector: '#0ea5e9', loop: '#0ea5e9', batch: '#0ea5e9', sub_workflow: '#0ea5e9', plugin: '#a855f7', http: '#a855f7', code: '#64748b', template: '#64748b', text_processor: '#64748b', json_parse: '#64748b', json_stringify: '#64748b', variable_aggregator: '#64748b', variable_assign: '#d946ef' };
function nodeColor(t) { return NODE_COLOR[t] || (t.indexOf('knowledge') === 0 ? '#10b981' : t.indexOf('database') === 0 ? '#f97316' : t.indexOf('conversation') === 0 || t.indexOf('message') === 0 ? '#ec4899' : '#6b7280'); }
var NODE_FORMS = {
  llm: [['model','Model','text'],['system','System','textarea'],['prompt','Prompt','textarea'],['temperature','Temperature','number']],
  http: [['url','URL','text'],['method','Method','select',['GET','POST','PUT','PATCH','DELETE']],['timeout_ms','Timeout (ms)','number']],
  condition: [['left','Vế trái','text'],['op','Toán tử','select',['eq','neq','contains','gt','lt','empty','not_empty']],['right','Vế phải','text']],
  template: [['template','Template','textarea']],
  output_emitter: [['template','Nội dung message','textarea']],
  question: [['question','Câu hỏi','textarea']],
  input: [['prompt','Yêu cầu nhập','text']],
  code: [['script','Script (đa dòng, x = expr)','textarea'],['expression','Hoặc expression đơn','text']],
  knowledge_retrieve: [['query','Query','text'],['top_k','Top K','number'],['min_score','Min score','number'],['search_type','Kiểu tìm','select',['hybrid','semantic','fulltext']]],
  knowledge_index: [['dataset_id','Dataset ID','text'],['name','Tên doc','text'],['text','Nội dung','textarea']],
  sub_workflow: [['workflow_id','Workflow ID','text']],
  loop: [['workflow_id','Workflow ID (body)','text'],['items','Items ({{node.field}})','text']],
  batch: [['workflow_id','Workflow ID (body)','text'],['items','Items','text'],['concurrency','Concurrency','number']],
  variable_assign: [['name','Tên biến','text'],['value','Giá trị','text']],
  text_processor: [['operation','Phép','select',['concat','split','replace','substring','lower','upper','trim']],['text','Text','text'],['separator','Separator','text']],
  json_parse: [['text','JSON text','text']],
  json_stringify: [['path','Path (vd nodeA.rows)','text']],
  database_query: [['database_id','Database ID','text'],['limit','Limit','number']],
  intent: [['input','Input','text']],
  end: [['template','Template output','textarea']]
};

RENDER.workflows = function() {
  var m = main();
  pagehead(m, 'Workflows', [el('button', { class: 'btn primary', text: '+ Workflow', onclick: function(){
    promptM('Tên workflow').then(function(name){
      if (!name) return;
      wapi('POST', '/workflows', { name: name, graph: { nodes: [{ id: 'start', type: 'start', data: { inputs: [] } }, { id: 'end', type: 'end', data: { template: '' } }], edges: [{ source: 'start', target: 'end' }] } })
        .then(function(w){ openWorkflow(w.id); }).catch(err);
    });
  }})]);
  var grid = el('div', { class: 'grid cols3' });
  m.appendChild(grid);
  wapi('GET', '/workflows').then(function(list){
    if (!list.length) { grid.appendChild(el('div', { class: 'empty card' }, el('div', { class: 'big', text: '🔀' }), el('div', { text: 'Chưa có workflow.' }))); return; }
    list.forEach(function(w){
      grid.appendChild(el('div', { class: 'card', style: 'cursor:pointer', onclick: function(){ openWorkflow(w.id); } },
        el('div', { class: 'row' }, el('b', { text: w.name }), el('span', { class: 'spacer' }), el('span', { class: 'badge ' + (w.status === 'published' ? 'ok' : 'mut'), text: w.status })),
        el('div', { class: 'sub', style: 'margin-top:6px', text: w.description || 'Cập nhật ' + fmtDate(w.updated_at) })));
    });
  }).catch(err);
};

function openWorkflow(id) {
  wapi('GET', '/workflows/' + id).then(function(wf){ wfEditor(wf); }).catch(err);
}

function wfEditor(wf) {
  var m = main();
  var graph = wf.graph || { nodes: [], edges: [] };
  graph.nodes = graph.nodes || []; graph.edges = graph.edges || [];
  var selected = null, connectFrom = null, dirty = false;
  var undoStack = [], redoStack = [];
  function snapshot() { undoStack.push(JSON.stringify(graph)); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; dirty = true; }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(graph)); graph = JSON.parse(undoStack.pop()); wireGraph(); render(); renderPanel(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(graph)); graph = JSON.parse(redoStack.pop()); wireGraph(); render(); renderPanel(); }
  function wireGraph() { graph.nodes = graph.nodes || []; graph.edges = graph.edges || []; }

  (function layout(){
    var depth = {}, inbound = {};
    graph.edges.forEach(function(e){ inbound[e.target] = (inbound[e.target] || 0) + 1; });
    var q = graph.nodes.filter(function(n){ return !inbound[n.id]; }).map(function(n){ return [n.id, 0]; });
    var seen = {};
    while (q.length) {
      var it = q.shift();
      if (seen[it[0]]) continue; seen[it[0]] = true; depth[it[0]] = it[1];
      graph.edges.forEach(function(e){ if (e.source === it[0]) q.push([e.target, it[1] + 1]); });
    }
    var col = {};
    graph.nodes.forEach(function(n){
      n.data = n.data || {};
      if (!n.data._pos) { var d = depth[n.id] || 0; col[d] = (col[d] || 0) + 1; n.data._pos = { x: 60 + d * 240, y: 60 + (col[d] - 1) * 120 }; }
    });
  })();

  pagehead(m, '🎨 ' + wf.name, [
    el('button', { class: 'btn primary', text: '💾 Lưu', onclick: function(){
      wapi('PATCH', '/workflows/' + wf.id, { graph: graph }).then(function(){ dirty = false; toast('✅ Đã lưu graph', 'ok'); }).catch(err);
    }}),
    el('button', { class: 'btn', text: '▶ Run', onclick: runModal }),
    el('button', { class: 'btn', text: '📦 Publish', onclick: function(){ wapi('POST', '/workflows/' + wf.id + '/publish').then(function(r){ toast('✅ v' + r.version, 'ok'); }).catch(err); } }),
    el('button', { class: 'btn', text: '+ Node', onclick: addNode }),
    el('button', { class: 'btn', text: '↩', title: 'Undo (Ctrl+Z)', onclick: undo }),
    el('button', { class: 'btn', text: '↪', title: 'Redo', onclick: redo }),
    el('button', { class: 'btn', text: '←', onclick: function(){
      if (!dirty) { go('workflows'); return; }
      confirmM('Có thay đổi chưa lưu — thoát?').then(function(ok){ if (ok) go('workflows'); });
    }})]);

  var wrap = el('div', { class: 'wf-wrap' });
  var canvasBox = el('div', { class: 'wf-canvas' });
  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { var e = document.createElementNS(NS, tag); if (attrs) Object.keys(attrs).forEach(function(k){ e.setAttribute(k, attrs[k]); }); return e; }
  var svg = svgEl('svg', { width: '100%', height: '100%' });
  var vb = { x: 0, y: 0, w: 1400, h: 900 };
  function applyVB() { svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h); }
  applyVB();
  var defs = svgEl('defs');
  var marker = svgEl('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#6366f1' }));
  defs.appendChild(marker); svg.appendChild(defs);
  canvasBox.appendChild(svg);
  var zb = el('div', { class: 'zoombar' },
    el('button', { text: '−', onclick: function(){ zoom(1.25); } }),
    el('button', { text: '+', onclick: function(){ zoom(0.8); } }),
    el('button', { text: '⤢', title: 'Fit', onclick: fit }));
  canvasBox.appendChild(zb);
  var panel = el('div', { class: 'wf-side' });
  wrap.appendChild(canvasBox); wrap.appendChild(panel);
  m.appendChild(wrap);

  function toWorld(ev) {
    var r = svg.getBoundingClientRect();
    return { x: vb.x + (ev.clientX - r.left) * vb.w / r.width, y: vb.y + (ev.clientY - r.top) * vb.h / r.height };
  }
  function zoom(f, cx, cy) {
    var r = svg.getBoundingClientRect();
    cx = cx == null ? vb.x + vb.w / 2 : cx; cy = cy == null ? vb.y + vb.h / 2 : cy;
    var nw = Math.min(Math.max(vb.w * f, 300), 8000);
    var nh = nw * r.height / r.width;
    vb.x = cx - (cx - vb.x) * nw / vb.w; vb.y = cy - (cy - vb.y) * nh / vb.h;
    vb.w = nw; vb.h = nh; applyVB();
  }
  function fit() {
    if (!graph.nodes.length) return;
    var xs = graph.nodes.map(function(n){ return n.data._pos.x; });
    var ys = graph.nodes.map(function(n){ return n.data._pos.y; });
    var minX = Math.min.apply(null, xs) - 60, minY = Math.min.apply(null, ys) - 60;
    var maxX = Math.max.apply(null, xs) + 250, maxY = Math.max.apply(null, ys) + 140;
    var r = svg.getBoundingClientRect();
    vb.x = minX; vb.y = minY; vb.w = Math.max(maxX - minX, 400); vb.h = Math.max(vb.w * r.height / r.width, maxY - minY);
    applyVB();
  }
  svg.addEventListener('wheel', function(ev){ ev.preventDefault(); var p = toWorld(ev); zoom(ev.deltaY > 0 ? 1.12 : 0.9, p.x, p.y); }, { passive: false });

  var drag = null, pan = null;
  svg.addEventListener('mousedown', function(ev){
    if (ev.target === svg || ev.target.tagName === 'path' && !ev.target.hasAttribute('data-edge')) return;
    if (ev.target === svg) return;
  });
  svg.addEventListener('mousedown', function(ev){
    if (ev.target.closest && ev.target.closest('[data-node]')) return;
    pan = { x: ev.clientX, y: ev.clientY, vx: vb.x, vy: vb.y };
  });
  svg.addEventListener('mousemove', function(ev){
    var r = svg.getBoundingClientRect();
    if (drag) {
      var p = toWorld(ev);
      drag.node.data._pos.x = p.x - drag.dx; drag.node.data._pos.y = p.y - drag.dy;
      drag.moved = true; render(); return;
    }
    if (pan) {
      vb.x = pan.vx - (ev.clientX - pan.x) * vb.w / r.width;
      vb.y = pan.vy - (ev.clientY - pan.y) * vb.h / r.height;
      applyVB();
    }
  });
  window.addEventListener('mouseup', function(){
    if (drag) { if (drag.moved) dirty = true; else nodeClick(drag.node); }
    drag = null; pan = null;
  });
  document.addEventListener('keydown', function(ev){
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); undo(); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'y') { ev.preventDefault(); redo(); }
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { deleteSelected(); }
  });

  function nodeClick(node) {
    if (connectFrom && connectFrom.id !== node.id) {
      promptM('Nhãn edge (trống = thường; true/false; tên nhánh; error)').then(function(label){
        if (label === null) { connectFrom = null; render(); return; }
        snapshot();
        graph.edges.push(label ? { source: connectFrom.id, target: node.id, label: label } : { source: connectFrom.id, target: node.id });
        connectFrom = null; selected = node; render(); renderPanel();
      });
    } else { selected = node; connectFrom = null; render(); renderPanel(); }
  }
  function deleteSelected() {
    if (!selected) return;
    var node = selected;
    confirmM('Xóa node ' + node.id + '?', true).then(function(ok){
      if (!ok) return;
      snapshot();
      graph.nodes = graph.nodes.filter(function(n){ return n.id !== node.id; });
      graph.edges = graph.edges.filter(function(e){ return e.source !== node.id && e.target !== node.id; });
      selected = null; render(); renderPanel();
    });
  }
  var nextNum = 1;
  function addNode() {
    var idIn = el('input', { value: 'n' + nextNum++, style: 'width:100%' });
    var typeSel = el('select', { style: 'width:100%;margin-top:8px' });
    NODE_TYPES.forEach(function(t){ typeSel.appendChild(el('option', { value: t, text: t })); });
    typeSel.value = 'llm';
    modal({ title: '+ Node mới', body: el('div', {}, field('ID', idIn), field('Loại', typeSel)), actions: [
      { label: 'Thêm', primary: true, value: function(){
        var nid = idIn.value.trim();
        if (!nid || graph.nodes.some(function(n){ return n.id === nid; })) { toast('ID trống hoặc trùng', 'err'); return undefined; }
        snapshot();
        graph.nodes.push({ id: nid, type: typeSel.value, data: { _pos: { x: vb.x + vb.w / 2 - 90, y: vb.y + vb.h / 2 - 32 } } });
        selected = graph.nodes[graph.nodes.length - 1];
        render(); renderPanel();
        return true;
      } },
      { label: 'Hủy', value: null }] });
  }

  function render() {
    while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
    var byId = {};
    graph.nodes.forEach(function(n){ byId[n.id] = n; });
    graph.edges.forEach(function(edge, idx){
      var s = byId[edge.source], t = byId[edge.target];
      if (!s || !t) return;
      var x1 = s.data._pos.x + 185, y1 = s.data._pos.y + 32;
      var x2 = t.data._pos.x, y2 = t.data._pos.y + 32;
      var mx = (x1 + x2) / 2;
      var p = svgEl('path', { d: 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2,
        fill: 'none', stroke: edge.label === 'error' ? '#dc2626' : '#6366f1', 'stroke-width': 2, 'marker-end': 'url(#arr)', 'data-edge': '1', opacity: '.85' });
      p.style.cursor = 'pointer';
      p.onclick = function(){ confirmM('Xóa edge ' + edge.source + ' → ' + edge.target + '?', true).then(function(ok){ if (ok) { snapshot(); graph.edges.splice(idx, 1); render(); } }); };
      svg.appendChild(p);
      if (edge.label) {
        var lb = svgEl('text', { x: mx, y: (y1 + y2) / 2 - 7, 'text-anchor': 'middle', 'font-size': 11, fill: edge.label === 'error' ? '#dc2626' : '#6366f1' });
        lb.textContent = edge.label;
        svg.appendChild(lb);
      }
    });
    graph.nodes.forEach(function(node){
      var isSel = selected && selected.id === node.id;
      var g = svgEl('g', { 'data-node': node.id });
      var color = nodeColor(node.type);
      g.appendChild(svgEl('rect', { x: node.data._pos.x, y: node.data._pos.y, width: 185, height: 64, rx: 12,
        fill: 'var(--card)', stroke: connectFrom && connectFrom.id === node.id ? '#f59e0b' : isSel ? color : 'var(--border)', 'stroke-width': isSel ? 2.5 : 1.5 }));
      g.appendChild(svgEl('rect', { x: node.data._pos.x, y: node.data._pos.y, width: 5, height: 64, rx: 2.5, fill: color }));
      var t1 = svgEl('text', { x: node.data._pos.x + 16, y: node.data._pos.y + 26, 'font-size': 13, 'font-weight': 600, fill: 'var(--text)' });
      t1.textContent = node.id;
      var t2 = svgEl('text', { x: node.data._pos.x + 16, y: node.data._pos.y + 46, 'font-size': 11, fill: color });
      t2.textContent = node.type;
      g.appendChild(t1); g.appendChild(t2);
      g.appendChild(svgEl('circle', { cx: node.data._pos.x + 185, cy: node.data._pos.y + 32, r: 4, fill: color }));
      g.appendChild(svgEl('circle', { cx: node.data._pos.x, cy: node.data._pos.y + 32, r: 4, fill: 'var(--border)' }));
      g.style.cursor = 'grab';
      g.addEventListener('mousedown', function(ev){
        ev.stopPropagation();
        var p = toWorld(ev);
        drag = { node: node, dx: p.x - node.data._pos.x, dy: p.y - node.data._pos.y, moved: false };
      });
      svg.appendChild(g);
    });
  }

  function renderPanel() {
    panel.innerHTML = '';
    if (!selected) {
      panel.appendChild(el('div', { class: 'card' }, el('b', { text: 'Canvas' }),
        el('div', { class: 'sub', style: 'margin-top:8px', text: 'Kéo node để di chuyển · kéo nền để pan · lăn chuột zoom · click node để cấu hình · Delete xóa node.' })));
      return;
    }
    var node = selected;
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'row' }, el('b', { text: node.id }), el('span', { class: 'badge info', text: node.type }), el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm danger', text: '🗑', onclick: deleteSelected })));
    var typeSel = el('select', { style: 'width:100%;margin-top:10px' });
    NODE_TYPES.forEach(function(t){ typeSel.appendChild(el('option', { value: t, text: t })); });
    typeSel.value = node.type;
    typeSel.onchange = function(){ snapshot(); node.type = typeSel.value; render(); renderPanel(); };
    card.appendChild(field('Loại node', typeSel));

    var form = NODE_FORMS[node.type];
    var inputs = {};
    if (form) {
      form.forEach(function(f){
        var key = f[0], label = f[1], kind = f[2];
        var cur = node.data[key];
        var inp;
        if (kind === 'textarea') { inp = el('textarea', { rows: 4 }); inp.value = cur == null ? '' : String(cur); }
        else if (kind === 'select') { inp = selInput(cur, f[3].map(function(o){ return [o, o]; })); }
        else if (kind === 'number') { inp = numInput(cur); }
        else { inp = el('input', { value: cur == null ? '' : String(cur), style: 'width:100%' }); }
        inputs[key] = [inp, kind];
        card.appendChild(field(label, inp));
      });
    }
    var extra = {};
    Object.keys(node.data).forEach(function(k){ if (k !== '_pos' && !(form && form.some(function(f){ return f[0] === k; }))) extra[k] = node.data[k]; });
    var jsonBox = el('textarea', { rows: form ? 5 : 12, class: 'mono' });
    jsonBox.value = JSON.stringify(extra, null, 2);
    card.appendChild(field(form ? 'Data khác (JSON)' : 'Data (JSON)', jsonBox));
    card.appendChild(el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn primary sm', text: 'Cập nhật', onclick: function(){
        try {
          snapshot();
          var next = JSON.parse(jsonBox.value || '{}');
          next._pos = node.data._pos;
          Object.keys(inputs).forEach(function(k){
            var v = inputs[k][0].value;
            if (v === '') return;
            next[k] = inputs[k][1] === 'number' ? Number(v) : v;
          });
          node.data = next;
          toast('✅ Node updated (nhớ 💾 Lưu)', 'ok');
          render();
        } catch (e) { err(e); }
      }}),
      el('button', { class: 'btn sm', text: '→ Nối tới…', onclick: function(){ connectFrom = node; toast('Chọn node đích'); render(); } }),
      el('button', { class: 'btn sm', text: '🧪 Debug node', onclick: function(){
        promptM('Scope JSON (kết quả giả của node trước)', JSON.stringify({ input: {} }, null, 2), true).then(function(v){
          if (v == null) return;
          var scope; try { scope = JSON.parse(v || '{}'); } catch (e) { err(e); return; }
          wapi('POST', '/workflows/' + wf.id + '/debug-node', { node_id: node.id, scope: scope }).then(function(r){
            modal({ title: '🧪 ' + node.id, wide: true, body: el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px', text: JSON.stringify(r, null, 2) }), actions: [{ label: 'Đóng', value: true }] });
          }).catch(err);
        });
      }})));
    panel.appendChild(card);
    panel.appendChild(el('div', { class: 'sub', style: 'margin-top:10px', text: 'Nhãn edge: true/false (condition) · tên nhánh (selector/intent) · error (error-branch).' }));
  }

  function runModal() {
    var inBox = el('textarea', { rows: 4, class: 'mono' }); inBox.value = '{}';
    var out = el('div', { style: 'margin-top:10px;max-height:44vh;overflow-y:auto' });
    function log(line, cls) { out.appendChild(el('div', { class: cls || 'sub', style: 'margin-top:4px', text: line })); out.scrollTop = out.scrollHeight; }
    function run() {
      out.innerHTML = '';
      var input; try { input = JSON.parse(inBox.value || '{}'); } catch (e) { err(e); return; }
      var llmBuf = {};
      fetch('/v1/workspaces/' + S.wid + '/workflows/' + wf.id + '/run', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + S.token, 'content-type': 'application/json' },
        body: JSON.stringify({ input: input, stream: true })
      }).then(function(res){
        if (!res.ok) return res.text().then(function(t){ log('❌ ' + t); });
        return readSSE(res, function(event, data){
          if (event === 'node_start') log('▶ ' + data.node_id + ' (' + data.node_type + ')');
          else if (event === 'node_delta') {
            if (!llmBuf[data.node_id]) { llmBuf[data.node_id] = el('div', { style: 'white-space:pre-wrap;font-size:12px;border-left:3px solid var(--primary);padding-left:8px;margin:4px 0' }); out.appendChild(llmBuf[data.node_id]); }
            llmBuf[data.node_id].textContent += data.content; out.scrollTop = out.scrollHeight;
          }
          else if (event === 'node_finish') log((data.errored ? '⚠ ' : '✓ ') + data.node_id + ' → ' + String(data.result).slice(0, 140));
          else if (event === 'message') log('💬 ' + data.content);
          else if (event === 'succeeded') { log('✅ DONE', ''); out.appendChild(el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px', text: JSON.stringify(data.output, null, 2) })); }
          else if (event === 'suspended') {
            log('⏸ Chờ trả lời: ' + data.question);
            var ans = el('input', { style: 'flex:1', placeholder: (data.options || []).join(' | ') || 'Trả lời…' });
            out.appendChild(el('div', { class: 'row', style: 'margin-top:6px' }, ans,
              el('button', { class: 'btn sm primary', text: 'Tiếp tục', onclick: function(){
                wapi('POST', '/workflows/' + wf.id + '/runs/' + data.run_id + '/resume', { value: ans.value }).then(function(r){
                  out.appendChild(el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px', text: JSON.stringify(r, null, 2) }));
                }).catch(err);
              }})));
          }
          else if (event === 'failed') log('❌ ' + data.error);
        });
      });
    }
    modal({ title: '▶ Run — ' + wf.name, wide: true, body: el('div', {}, field('Input JSON', inBox), out), actions: [
      { label: '▶ Run (stream)', primary: true, value: function(){ run(); return undefined; } },
      { label: 'Đóng', value: null }] });
  }

  render(); renderPanel(); setTimeout(fit, 30);
}

/* ================= plugins ================= */
RENDER.plugins = function() {
  var m = main();
  pagehead(m, 'Plugins', [
    el('button', { class: 'btn primary', text: '+ Plugin', onclick: function(){
      var n = el('input', { style: 'width:100%', placeholder: 'Tên' });
      var u = el('input', { style: 'width:100%', placeholder: 'https://api.example.com' });
      modal({ title: 'Plugin mới', body: el('div', {}, field('Tên', n), field('Base URL', u)), actions: [
        { label: 'Tạo', primary: true, value: function(){ if (n.value && u.value) wapi('POST', '/plugins', { name: n.value, base_url: u.value }).then(RENDER.plugins).catch(err); return true; } },
        { label: 'Hủy', value: null }] });
    }}),
    el('button', { class: 'btn', text: '📥 Import spec', onclick: function(){
      var t = el('textarea', { rows: 10, class: 'mono', placeholder: 'Dán OpenAPI 3.x / Swagger 2.x (JSON|YAML), lệnh curl, hoặc Postman collection…' });
      modal({ title: '📥 Import plugin', wide: true, body: el('div', {}, t), actions: [
        { label: 'Import', primary: true, value: function(){
          if (!t.value.trim()) return undefined;
          wapi('POST', '/plugins/import', { data: t.value }).then(function(r){
            toast('✅ ' + r.tools_imported + ' tools' + (r.warnings.length ? ' — ' + r.warnings.join('; ') : ''), 'ok'); RENDER.plugins();
          }).catch(err);
          return true;
        } }, { label: 'Hủy', value: null }] });
    }}),
    el('button', { class: 'btn', text: '🧩 MCP server', onclick: function(){
      var u = el('input', { style: 'width:100%', placeholder: 'https://mcp.example.com/mcp' });
      var h = el('textarea', { rows: 3, class: 'mono', placeholder: '{"authorization": "Bearer …"} (tùy chọn)' });
      modal({ title: '🧩 Kết nối MCP server', body: el('div', {}, field('URL', u), field('Headers JSON', h)), actions: [
        { label: 'Kết nối', primary: true, value: function(){
          var headers = {}; try { headers = h.value ? JSON.parse(h.value) : {}; } catch (e) { err(e); return undefined; }
          wapi('POST', '/plugins/mcp', { base_url: u.value, headers: headers }).then(function(r){ toast('✅ ' + r.tools_imported + ' MCP tools', 'ok'); RENDER.plugins(); }).catch(err);
          return true;
        } }, { label: 'Hủy', value: null }] });
    }})]);
  var box = el('div', { class: 'grid', style: 'grid-template-columns:1fr' });
  m.appendChild(box);
  wapi('GET', '/plugins').then(function(list){
    if (!list.length) { box.appendChild(el('div', { class: 'empty card' }, el('div', { class: 'big', text: '🔌' }), el('div', { text: 'Chưa có plugin — tạo, import spec, hoặc kết nối MCP.' }))); return; }
    list.forEach(function(p){ box.appendChild(pluginCard(p)); });
  }).catch(err);

  function pluginCard(p) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'row' },
      el('b', { text: (p.kind === 'mcp' ? '🧩 ' : '🔌 ') + p.name }),
      el('span', { class: 'sub', text: p.base_url }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', text: 'Auth/cấu hình', onclick: function(){ editPluginModal(p.id); } }),
      p.kind === 'mcp' ? el('button', { class: 'btn sm', text: '↻ Sync', onclick: function(){ wapi('POST', '/plugins/' + p.id + '/mcp/sync').then(function(r){ toast('✅ +' + r.added + ' ~' + r.updated + ' -' + r.removed, 'ok'); RENDER.plugins(); }).catch(err); } }) : '',
      el('button', { class: 'btn sm', text: '🔐 Vault', title: 'Mã hóa secrets', onclick: function(){ wapi('POST', '/plugins/' + p.id + '/vault').then(function(r){ toast(r.already_vaulted ? 'Đã vault từ trước' : '✅ Secrets đã vào Vault', 'ok'); }).catch(err); } }),
      el('button', { class: 'btn sm', text: '📦 Publish', onclick: function(){
        wapi('POST', '/plugins/' + p.id + '/publish', {}).then(function(r){ toast('✅ v' + r.version, 'ok'); })
          .catch(function(e){ confirmM(e.message + ' — publish force?').then(function(ok){ if (ok) wapi('POST', '/plugins/' + p.id + '/publish', { force: true }).then(function(r){ toast('✅ v' + r.version, 'ok'); }).catch(err); }); });
      }}),
      el('button', { class: 'btn sm danger', text: '✕', onclick: function(){ confirmM('Xóa plugin "' + p.name + '"?', true).then(function(ok){ if (ok) wapi('DELETE', '/plugins/' + p.id).then(RENDER.plugins).catch(err); }); } })));
    var tbox = el('div'); card.appendChild(tbox);
    wapi('GET', '/plugins/' + p.id + '/tools').then(function(tools){
      if (!tools.length) { tbox.appendChild(el('div', { class: 'sub', style: 'margin-top:8px', text: 'Chưa có tool.' })); return; }
      var t = el('table', { class: 't' });
      t.appendChild(el('tr', {}, el('th', { text: 'Tool' }), el('th', { text: 'Method' }), el('th', { text: 'Path' }), el('th', { text: 'Debug' }), el('th')));
      tools.forEach(function(tool){
        t.appendChild(el('tr', {},
          el('td', {}, el('b', { text: tool.name }), el('div', { class: 'sub', text: (tool.description || '').slice(0, 70) })),
          el('td', {}, el('span', { class: 'badge mut', text: tool.method })),
          el('td', { class: 'sub', text: tool.path }),
          el('td', {}, el('span', { class: 'badge ' + (tool.debug_status === 'passed' ? 'ok' : 'warn'), text: tool.debug_status === 'passed' ? '✓ passed' : 'waiting' })),
          el('td', {}, el('button', { class: 'btn sm', text: '🧪 Invoke', onclick: function(){ invokeModal(p, tool); } }))));
      });
      tbox.appendChild(t);
    });
    return card;
  }
  function editPluginModal(pid) {
    wapi('GET', '/plugins/' + pid).then(function(p){
      var box2 = el('textarea', { rows: 12, class: 'mono' });
      box2.value = JSON.stringify({ name: p.name, description: p.description, base_url: p.base_url, auth: p.auth }, null, 2);
      modal({ title: '⚙ ' + p.name, wide: true, body: el('div', {}, box2,
        el('div', { class: 'hint', text: 'auth: {type:"none"} | {type:"api_key", in:"header|query", name, value} | {type:"oauth2", client_id, client_secret, auth_url, token_url, scopes}' })), actions: [
        { label: '💾 Lưu', primary: true, value: function(){ try { wapi('PATCH', '/plugins/' + pid, JSON.parse(box2.value)).then(function(){ toast('✅', 'ok'); RENDER.plugins(); }).catch(err); return true; } catch (e) { err(e); return undefined; } } },
        { label: '🔗 OAuth connect', value: function(){ wapi('GET', '/plugins/' + pid + '/oauth/url').then(function(r){ window.open(r.url, '_blank'); }).catch(err); return undefined; } },
        { label: 'Đóng', value: null }] });
    }).catch(err);
  }
  function invokeModal(p, tool) {
    var body = el('div');
    var inputs = {};
    (tool.parameters || []).forEach(function(prm){
      var inp = el('input', { style: 'width:100%', placeholder: (prm.schema && prm.schema.type) || 'string' });
      inputs[prm.name] = [inp, prm];
      body.appendChild(field(prm.name + (prm.required ? ' *' : '') + '  (' + prm.in + ')', inp, prm.description));
    });
    if (!(tool.parameters || []).length) body.appendChild(el('div', { class: 'sub', text: 'Tool không có tham số.' }));
    var out = el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;max-height:30vh;overflow-y:auto' });
    body.appendChild(out);
    modal({ title: '🧪 ' + tool.name, wide: true, body: body, actions: [
      { label: '▶ Invoke', primary: true, value: function(){
        var args = {};
        Object.keys(inputs).forEach(function(k){
          var v = inputs[k][0].value; if (v === '') return;
          var ty = inputs[k][1].schema && inputs[k][1].schema.type;
          args[k] = ty === 'number' ? Number(v) : ty === 'boolean' ? v === 'true' : v;
        });
        out.textContent = '…';
        wapi('POST', '/plugins/' + p.id + '/tools/' + tool.id + '/invoke', { args: args }).then(function(r){
          out.textContent = 'HTTP ' + r.status + '\\n' + r.body; RENDER.plugins();
        }).catch(function(e){ out.textContent = '❌ ' + e.message; });
        return undefined;
      } }, { label: 'Đóng', value: null }] });
  }
};

/* ================= databases ================= */
RENDER.databases = function() {
  var m = main();
  pagehead(m, 'Databases (memory)', [
    el('button', { class: 'btn primary', text: '+ Database', onclick: function(){
      promptM('Tên database').then(function(name){ if (name) wapi('POST', '/databases', { name: name, columns: [{ name: 'title', type: 'text', required: true }] }).then(RENDER.databases).catch(err); });
    }}),
    el('button', { class: 'btn', text: '📥 Import xlsx/csv', onclick: function(){
      var n = el('input', { style: 'width:100%', placeholder: 'Tên DB' });
      var f = el('input', { type: 'file', accept: '.xlsx,.csv,.tsv', style: 'width:100%' });
      modal({ title: '📥 Import bảng', body: el('div', {}, field('Tên', n), field('File', f)), actions: [
        { label: 'Import', primary: true, value: function(){
          var file = f.files[0]; if (!file || !n.value) return undefined;
          fileToB64(file).then(function(b64){ return wapi('POST', '/databases/import', { name: n.value, filename: file.name, content_base64: b64 }); })
            .then(function(r){ toast('✅ ' + r.inserted + ' rows (bỏ ' + r.skipped + ')', 'ok'); RENDER.databases(); }).catch(err);
          return true;
        } }, { label: 'Hủy', value: null }] });
    }})]);
  var box = el('div', { class: 'grid cols3' });
  m.appendChild(box);
  wapi('GET', '/databases').then(function(list){
    if (!list.length) { box.appendChild(el('div', { class: 'empty card' }, el('div', { class: 'big', text: '🗄️' }), el('div', { text: 'Chưa có database.' }))); return; }
    list.forEach(function(db){
      box.appendChild(el('div', { class: 'card', style: 'cursor:pointer', onclick: function(){ dbDetail(db); } },
        el('div', { class: 'row' }, el('b', { text: db.name }), el('span', { class: 'spacer' }), el('span', { class: 'badge mut', text: db.rw_mode || 'unlimited' })),
        el('div', { class: 'sub', style: 'margin-top:6px', text: (db.columns || []).map(function(c){ return c.name; }).join(', ') })));
    });
  }).catch(err);
};
function dbDetail(db) {
  var m = main();
  pagehead(m, '🗄️ ' + db.name, [
    el('button', { class: 'btn', text: '⚙ Cột & chế độ', onclick: function(){
      var box2 = el('textarea', { rows: 10, class: 'mono' });
      box2.value = JSON.stringify({ name: db.name, description: db.description, rw_mode: db.rw_mode || 'unlimited', columns: db.columns }, null, 2);
      modal({ title: '⚙ Schema', wide: true, body: el('div', {}, box2, el('div', { class: 'hint', text: 'rw_mode: unlimited | read_only | per_user (mỗi end-user thấy dữ liệu của mình)' })), actions: [
        { label: 'Lưu', primary: true, value: function(){ try { wapi('PATCH', '/databases/' + db.id, JSON.parse(box2.value)).then(function(d){ dbDetail(d); }).catch(err); return true; } catch (e) { err(e); return undefined; } } },
        { label: 'Hủy', value: null }] });
    }}),
    el('button', { class: 'btn danger', text: '🗑', onclick: function(){ confirmM('Xóa database?', true).then(function(ok){ if (ok) wapi('DELETE', '/databases/' + db.id).then(function(){ go('databases'); }).catch(err); }); } }),
    el('button', { class: 'btn', text: '←', onclick: function(){ go('databases'); } })]);
  var cols = (db.columns || []);
  var filterCol = selInput('', [['', '(lọc theo cột)']].concat(cols.map(function(c){ return [c.name, c.name]; })));
  var filterOp = selInput('eq', [['eq','='],['neq','≠'],['contains','chứa'],['gt','>'],['lt','<']]);
  var filterVal = el('input', { placeholder: 'giá trị' });
  var addBtn = el('button', { class: 'btn primary sm', text: '+ Row', onclick: function(){
    var body = el('div');
    var inputs = {};
    cols.forEach(function(c){ var inp = el('input', { style: 'width:100%', placeholder: c.type }); inputs[c.name] = inp; body.appendChild(field(c.name + (c.required ? ' *' : ''), inp)); });
    modal({ title: '+ Row', body: body, actions: [
      { label: 'Thêm', primary: true, value: function(){
        var data = {};
        cols.forEach(function(c){ if (inputs[c.name].value !== '') data[c.name] = inputs[c.name].value; });
        wapi('POST', '/databases/' + db.id + '/rows', { data: data }).then(function(){ load(); }).catch(err);
        return true;
      } }, { label: 'Hủy', value: null }] });
  }});
  m.appendChild(el('div', { class: 'card' },
    el('div', { class: 'row' }, filterCol, filterOp, filterVal, el('button', { class: 'btn sm', text: 'Lọc', onclick: load }), el('span', { class: 'spacer' }), addBtn)));
  var listBox = el('div', { class: 'card', style: 'margin-top:12px;overflow-x:auto' });
  m.appendChild(listBox);
  function load() {
    listBox.innerHTML = ''; listBox.appendChild(el('div', { class: 'skl', style: 'height:40px' }));
    var filters = filterCol.value ? [{ column: filterCol.value, op: filterOp.value, value: filterVal.value }] : [];
    wapi('POST', '/databases/' + db.id + '/rows/query', { filters: filters, limit: 200 }).then(function(r){
      listBox.innerHTML = '';
      listBox.appendChild(el('div', { class: 'sub', text: r.count + ' rows' }));
      var t = el('table', { class: 't' });
      var head = el('tr');
      cols.forEach(function(c){ head.appendChild(el('th', { text: c.name })); });
      head.appendChild(el('th'));
      t.appendChild(head);
      r.rows.forEach(function(row){
        var tr = el('tr');
        cols.forEach(function(c){ tr.appendChild(el('td', { text: String(row.data[c.name] == null ? '' : row.data[c.name]).slice(0, 60) })); });
        tr.appendChild(el('td', {}, el('div', { class: 'row' },
          el('button', { class: 'btn sm', text: '✎', onclick: function(){
            promptM('Data JSON', JSON.stringify(row.data, null, 2), true).then(function(v){
              if (v == null) return;
              try { wapi('PATCH', '/databases/' + db.id + '/rows/' + row.id, { data: JSON.parse(v) }).then(load).catch(err); } catch (e) { err(e); }
            });
          }}),
          el('button', { class: 'btn sm danger', text: '✕', onclick: function(){ wapi('DELETE', '/databases/' + db.id + '/rows/' + row.id).then(load).catch(err); } }))));
        t.appendChild(tr);
      });
      listBox.appendChild(t);
    }).catch(err);
  }
  load();
}

/* ================= apps / prompts / keys / usage / search / settings ================= */
RENDER.apps = function() {
  var m = main();
  pagehead(m, 'Apps (đóng gói)', [el('button', { class: 'btn primary', text: '+ App', onclick: function(){
    promptM('Tên app').then(function(name){ if (name) wapi('POST', '/apps', { name: name }).then(RENDER.apps).catch(err); });
  }})]);
  var box = el('div', { class: 'grid cols3' }); m.appendChild(box);
  wapi('GET', '/apps').then(function(list){
    if (!list.length) { box.appendChild(el('div', { class: 'empty card' }, el('div', { class: 'big', text: '📦' }), el('div', { text: 'App = bundle agents + workflows + knowledge + databases + plugins, publish theo version.' }))); return; }
    list.forEach(function(a){ box.appendChild(el('div', { class: 'card', style: 'cursor:pointer', onclick: function(){ appDetail(a.id); } }, el('b', { text: a.name }), el('div', { class: 'sub', style: 'margin-top:6px', text: a.description || fmtDate(a.updated_at) }))); });
  }).catch(err);
};
function appDetail(id) {
  var m = main();
  wapi('GET', '/apps/' + id).then(function(a){
    var picks = {};
    pagehead(m, '📦 ' + a.name, [
      el('button', { class: 'btn primary', text: '💾 Lưu', onclick: function(){
        wapi('PATCH', '/apps/' + id, {
          agent_ids: picks.agents.getIds(), workflow_ids: picks.workflows.getIds(),
          dataset_ids: picks.datasets.getIds(), database_ids: picks.databases.getIds(), plugin_ids: picks.plugins.getIds()
        }).then(function(){ toast('✅ Đã lưu', 'ok'); }).catch(err);
      }}),
      el('button', { class: 'btn', text: '📦 Publish version', onclick: function(){
        wapi('POST', '/apps/' + id + '/publish').then(function(r){ toast('✅ v' + r.version + ' — ' + JSON.stringify(r.packed), 'ok'); appDetail(id); }).catch(err);
      }}),
      el('button', { class: 'btn danger', text: '🗑', onclick: function(){ confirmM('Xóa app?', true).then(function(ok){ if (ok) wapi('DELETE', '/apps/' + id).then(function(){ go('apps'); }).catch(err); }); } }),
      el('button', { class: 'btn', text: '←', onclick: function(){ go('apps'); } })]);
    var card = el('div', { class: 'card' });
    picks.agents = multiPick('/agents', a.agent_ids);
    picks.workflows = multiPick('/workflows', a.workflow_ids);
    picks.datasets = multiPick('/datasets', a.dataset_ids);
    picks.databases = multiPick('/databases', a.database_ids);
    picks.plugins = multiPick('/plugins', a.plugin_ids);
    card.appendChild(field('🤖 Agents', picks.agents));
    card.appendChild(field('🔀 Workflows', picks.workflows));
    card.appendChild(field('📚 Knowledge', picks.datasets));
    card.appendChild(field('🗄️ Databases', picks.databases));
    card.appendChild(field('🔌 Plugins', picks.plugins));
    m.appendChild(card);
    var rel = el('div', { class: 'card', style: 'margin-top:12px' }, el('b', { text: 'Releases' }));
    m.appendChild(rel);
    wapi('GET', '/apps/' + id + '/releases').then(function(rs){
      if (!rs.length) { rel.appendChild(el('div', { class: 'sub', text: 'Chưa publish version nào.' })); return; }
      var t = el('table', { class: 't' });
      rs.forEach(function(r){
        t.appendChild(el('tr', {}, el('td', {}, el('b', { text: 'v' + r.version })), el('td', { class: 'sub', text: fmtDate(r.created_at) }),
          el('td', {}, el('button', { class: 'btn sm', text: '⬇ Restore (tạo bản copy)', onclick: function(){
            confirmM('Tạo bản copy toàn bộ tài nguyên từ v' + r.version + '?').then(function(ok){
              if (ok) wapi('POST', '/apps/' + id + '/releases/' + r.version + '/restore').then(function(res){ toast('✅ ' + JSON.stringify(res.created), 'ok'); }).catch(err);
            });
          }}))));
      });
      rel.appendChild(t);
    });
  }).catch(err);
}
RENDER.prompts = function() {
  var m = main();
  pagehead(m, 'Prompt library', [el('button', { class: 'btn primary', text: '+ Prompt', onclick: function(){
    promptM('Tên prompt').then(function(name){ if (name) wapi('POST', '/prompts', { name: name, prompt: '' }).then(RENDER.prompts).catch(err); });
  }})]);
  var box = el('div', { class: 'grid cols3' }); m.appendChild(box);
  wapi('GET', '/prompts').then(function(list){
    if (!list.length) { box.appendChild(el('div', { class: 'empty card', text: 'Chưa có prompt nào.' })); return; }
    list.forEach(function(p){
      box.appendChild(el('div', { class: 'card', style: 'cursor:pointer', onclick: function(){
        wapi('GET', '/prompts/' + p.id).then(function(full){
          var n = el('input', { style: 'width:100%' }); n.value = full.name;
          var d = el('input', { style: 'width:100%' }); d.value = full.description || '';
          var t = el('textarea', { rows: 10 }); t.value = full.prompt || '';
          modal({ title: '📝 ' + full.name, wide: true, body: el('div', {}, field('Tên', n), field('Mô tả', d), field('Prompt', t)), actions: [
            { label: '💾 Lưu', primary: true, value: function(){ wapi('PATCH', '/prompts/' + p.id, { name: n.value, description: d.value, prompt: t.value }).then(RENDER.prompts).catch(err); return true; } },
            { label: '🗑 Xóa', danger: true, value: function(){ wapi('DELETE', '/prompts/' + p.id).then(RENDER.prompts).catch(err); return true; } },
            { label: 'Đóng', value: null }] });
        }).catch(err);
      }}, el('b', { text: p.name }), el('div', { class: 'sub', style: 'margin-top:6px', text: p.description || '' })));
    });
  }).catch(err);
};
RENDER.keys = function() {
  var m = main();
  pagehead(m, 'API Keys', [el('button', { class: 'btn primary', text: '+ Key', onclick: function(){
    promptM('Tên key').then(function(name){
      if (!name) return;
      wapi('POST', '/api-keys', { name: name }).then(function(k){
        modal({ title: '🔑 Key mới — chỉ hiển thị MỘT lần', body: el('input', { value: k.key, style: 'width:100%', onclick: function(ev){ ev.target.select(); } }), actions: [{ label: 'Đã copy', primary: true, value: true }] }).then(RENDER.keys);
      }).catch(err);
    });
  }})]);
  var card = el('div', { class: 'card' }); m.appendChild(card);
  wapi('GET', '/api-keys').then(function(list){
    if (!list.length) { card.appendChild(el('div', { class: 'empty', text: 'Chưa có API key.' })); return; }
    var t = el('table', { class: 't' });
    t.appendChild(el('tr', {}, el('th', { text: 'Tên' }), el('th', { text: 'Prefix' }), el('th', { text: 'Dùng lần cuối' }), el('th', { text: 'Trạng thái' }), el('th')));
    list.forEach(function(k){
      t.appendChild(el('tr', {}, el('td', {}, el('b', { text: k.name })), el('td', { class: 'sub', text: k.prefix + '…' }),
        el('td', { class: 'sub', text: fmtDate(k.last_used_at) }),
        el('td', {}, el('span', { class: 'badge ' + (k.revoked_at ? 'err' : 'ok'), text: k.revoked_at ? 'revoked' : 'active' })),
        el('td', {}, k.revoked_at ? '' : el('button', { class: 'btn sm danger', text: 'Thu hồi', onclick: function(){ confirmM('Thu hồi key?', true).then(function(ok){ if (ok) wapi('DELETE', '/api-keys/' + k.id).then(RENDER.keys).catch(err); }); } }))));
    });
    card.appendChild(t);
  }).catch(err);
};
RENDER.usage = function() {
  var m = main();
  pagehead(m, 'Usage (30 ngày)');
  var card = el('div', { class: 'card' }); m.appendChild(card);
  wapi('GET', '/usage').then(function(u){
    if (!u.totals.length) { card.appendChild(el('div', { class: 'empty', text: 'Chưa có usage.' })); return; }
    var max = Math.max.apply(null, u.totals.map(function(r){ return r.prompt_tokens + r.completion_tokens; }));
    var t = el('table', { class: 't' });
    t.appendChild(el('tr', {}, el('th', { text: 'Loại' }), el('th', { text: 'Model' }), el('th', { text: 'Tokens' }), el('th', { text: '' }), el('th', { text: 'Lượt' })));
    u.totals.forEach(function(r){
      var tot = r.prompt_tokens + r.completion_tokens;
      var bar = el('div', { class: 'usagebar', style: 'width:160px' }, el('i', { style: 'width:' + Math.round(tot / max * 100) + '%' }));
      t.appendChild(el('tr', {}, el('td', {}, el('span', { class: 'badge info', text: r.kind })), el('td', { text: r.model }),
        el('td', { text: fmtNum(tot) + ' (' + fmtNum(r.prompt_tokens) + ' in / ' + fmtNum(r.completion_tokens) + ' out)' }),
        el('td', {}, bar), el('td', { text: String(r.events) })));
    });
    card.appendChild(t);
  }).catch(err);
  var perf = el('div', { class: 'card', style: 'margin-top:12px' }, el('b', { text: '🔬 Hiệu năng DB (pg_stat_statements)' }));
  m.appendChild(perf);
  wapi('GET', '/admin/perf').then(function(r){
    var t = el('table', { class: 't' });
    t.appendChild(el('tr', {}, el('th', { text: 'Query' }), el('th', { text: 'Calls' }), el('th', { text: 'Mean ms' })));
    (r.queries || []).slice(0, 10).forEach(function(q){
      t.appendChild(el('tr', {}, el('td', { class: 'sub', style: 'font-family:ui-monospace,monospace;font-size:11px', text: q.query.slice(0, 110) }),
        el('td', { text: String(q.calls) }), el('td', { text: Number(q.mean_ms).toFixed(1) })));
    });
    perf.appendChild(t);
  }).catch(function(e){ perf.appendChild(el('div', { class: 'sub', text: e.message })); });
};
RENDER.search = function() {
  var m = main();
  pagehead(m, 'Tìm kiếm');
  var q = el('input', { style: 'flex:1', placeholder: 'Từ khóa…' });
  var box = el('div', { style: 'margin-top:14px' });
  m.appendChild(el('div', { class: 'row' }, q, el('button', { class: 'btn primary', text: 'Tìm', onclick: run })));
  m.appendChild(box);
  q.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') run(); });
  q.focus();
  function run() {
    box.innerHTML = ''; box.appendChild(el('div', { class: 'skl', style: 'height:40px' }));
    wapi('GET', '/search?q=' + encodeURIComponent(q.value)).then(function(r){
      box.innerHTML = '';
      var icons = { agents: '🤖', workflows: '🔀', datasets: '📚', plugins: '🔌', prompts: '📝' };
      var views = { agents: 'agents', workflows: 'workflows', datasets: 'knowledge', plugins: 'plugins', prompts: 'prompts' };
      var any = false;
      Object.keys(r).forEach(function(kind){
        if (!r[kind].length) return;
        any = true;
        r[kind].forEach(function(x){
          box.appendChild(el('div', { class: 'card', style: 'margin-top:8px;cursor:pointer', onclick: function(){ go(views[kind] || 'home'); } },
            el('b', { text: (icons[kind] || '') + ' ' + x.name }), el('span', { class: 'sub', text: '  ' + (x.description || '') })));
        });
      });
      if (!any) box.appendChild(el('div', { class: 'empty', text: 'Không có kết quả.' }));
    }).catch(err);
  }
};
RENDER.settings = function() {
  var m = main();
  pagehead(m, 'Cài đặt');
  var tok = el('textarea', { rows: 3, placeholder: 'Supabase access token hoặc czk_ API key' }); tok.value = S.token;
  m.appendChild(el('div', { class: 'card' }, el('b', { text: 'Bearer token' }), tok,
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { class: 'btn primary', text: 'Lưu token', onclick: function(){
        S.token = tok.value.trim(); localStorage.setItem('cz-token', S.token);
        loadWorkspaces().then(function(){ toast('✅ Token OK', 'ok'); go('home'); }).catch(err);
      }}),
      el('button', { class: 'btn danger', text: 'Đăng xuất', onclick: function(){ localStorage.removeItem('cz-token'); location.reload(); } }))));
  var su = el('input', { style: 'width:100%', placeholder: 'https://xxxx.supabase.co' });
  var sk = el('input', { style: 'width:100%', placeholder: 'anon key' });
  var em = el('input', { placeholder: 'email', style: 'flex:1' });
  var pw = el('input', { placeholder: 'password', type: 'password', style: 'flex:1' });
  m.appendChild(el('div', { class: 'card', style: 'margin-top:12px' },
    el('b', { text: 'Đăng nhập qua Supabase Auth' }),
    field('Supabase URL', su), field('Anon key', sk),
    el('div', { class: 'row', style: 'margin-top:10px' }, em, pw,
      el('button', { class: 'btn primary', text: 'Đăng nhập', onclick: function(){
        fetch(su.value.replace(/\\/+$/, '') + '/auth/v1/token?grant_type=password', {
          method: 'POST', headers: { 'content-type': 'application/json', apikey: sk.value },
          body: JSON.stringify({ email: em.value, password: pw.value })
        }).then(function(r){ return r.json(); }).then(function(j){
          if (!j.access_token) throw new Error(j.error_description || j.msg || 'login failed');
          S.token = j.access_token; localStorage.setItem('cz-token', S.token);
          loadWorkspaces().then(function(){ toast('✅ Đã đăng nhập', 'ok'); go('home'); });
        }).catch(err);
      }}))));
  m.appendChild(el('div', { class: 'card', style: 'margin-top:12px' },
    el('b', { text: 'Thành viên workspace' }),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('input', { id: 'inv-email', placeholder: 'email@congty.com', style: 'flex:1' }),
      el('button', { class: 'btn', text: '✉ Mời', onclick: function(){
        var email = document.getElementById('inv-email').value.trim();
        if (email) wapi('POST', '/members', { email: email }).then(function(r){ toast(r.invited ? '✅ Đã gửi email mời' : '✅ Đã thêm thành viên', 'ok'); }).catch(err);
      }}))));
};

/* ================= boot ================= */
buildNav();
document.getElementById('menubtn').onclick = function(){ document.getElementById('side').classList.toggle('open'); };
if (S.token) loadWorkspaces().then(function(){ go(S.view); }).catch(function(){ go('settings'); });
else go('settings');
`
