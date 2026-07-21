// Shared client-side runtime: DOM helpers, API client, toast stack, promise-
// based modal system (replaces alert/prompt/confirm), and a mini markdown
// renderer. Written without template literals so it can live in a TS string.
export const clientLib = `
'use strict';
var S = { token: localStorage.getItem('cz-token') || '', wid: localStorage.getItem('cz-wid') || '', view: localStorage.getItem('cz-view') || 'home' };

function el(tag, attrs) {
  var e = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function(k){
    if (k === 'onclick') e.onclick = attrs[k];
    else if (k === 'oninput') e.oninput = attrs[k];
    else if (k === 'onchange') e.onchange = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  });
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c === 0 || c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return e;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function main() { var m = document.getElementById('main'); m.innerHTML = ''; return m; }
function fmtDate(s) { return s ? String(s).slice(0, 16).replace('T', ' ') : '—'; }
function fmtNum(n) { n = Number(n || 0); return n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? (n/1e3).toFixed(1) + 'k' : String(n); }

function toast(msg, kind) {
  var box = document.getElementById('toasts');
  var t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
  box.appendChild(t);
  setTimeout(function(){ t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function(){ t.remove(); }, 350); }, 3400);
}
function err(e) { toast((e && e.message) || String(e), 'err'); }

function api(method, path, body) {
  return fetch('/v1' + path, {
    method: method,
    headers: { 'authorization': 'Bearer ' + S.token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
}
function wapi(method, path, body) { return api(method, '/workspaces/' + S.wid + path, body); }

/* ---------- modal system ---------- */
function modal(opts) {
  return new Promise(function(resolve){
    var ovl = el('div', { class: 'ovl' });
    var body = el('div', { class: 'mb' });
    if (typeof opts.body === 'string') body.textContent = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    var foot = el('div', { class: 'mf' });
    function close(v) { ovl.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
    function onKey(ev) { if (ev.key === 'Escape') close(null); }
    (opts.actions || [{ label: 'OK', primary: true, value: true }, { label: 'Hủy', value: null }]).forEach(function(a){
      foot.appendChild(el('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), text: a.label, onclick: function(){
        var v = typeof a.value === 'function' ? a.value() : a.value;
        if (v !== undefined) close(v);
      }}));
    });
    var box = el('div', { class: 'modal' + (opts.wide ? ' wide' : '') }, el('div', { class: 'mh', text: opts.title || '' }), body, foot);
    ovl.appendChild(box);
    ovl.onclick = function(ev){ if (ev.target === ovl) close(null); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ovl);
    var first = body.querySelector('input, textarea, select'); if (first) first.focus();
  });
}
function confirmM(msg, danger) {
  return modal({ title: 'Xác nhận', body: msg, actions: [
    { label: danger ? 'Xóa' : 'Đồng ý', primary: !danger, danger: !!danger, value: true },
    { label: 'Hủy', value: null }
  ] }).then(function(v){ return !!v; });
}
function promptM(title, def, multiline) {
  var input = multiline ? el('textarea', { rows: 6, class: 'mono' }) : el('input', { style: 'width:100%' });
  input.value = def || '';
  return modal({ title: title, body: el('div', {}, input), actions: [
    { label: 'OK', primary: true, value: function(){ return input.value; } },
    { label: 'Hủy', value: null }
  ] });
}

/* ---------- mini markdown ---------- */
function mdInline(s) {
  s = s.replace(/\\\`([^\\\`]+)\\\`/g, function(_, c){ return '<code>' + c + '</code>'; });
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<i>$2</i>');
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function md(src) {
  var out = [];
  var lines = esc(src || '').split('\\n');
  var i = 0, buf = [], inList = null;
  function flushP() { if (buf.length) { out.push('<p>' + buf.map(mdInline).join('<br>') + '</p>'); buf = []; } }
  function flushL() { if (inList) { out.push('</' + inList + '>'); inList = null; } }
  while (i < lines.length) {
    var line = lines[i];
    if (/^\\s*\\\`\\\`\\\`/.test(line)) {
      flushP(); flushL();
      var code = []; i++;
      while (i < lines.length && !/^\\s*\\\`\\\`\\\`/.test(lines[i])) { code.push(lines[i]); i++; }
      out.push('<pre><button class="cp" data-copy>Copy</button><code>' + code.join('\\n') + '</code></pre>');
      i++; continue;
    }
    if (/^#{1,3}\\s/.test(line)) { flushP(); flushL(); var lvl = line.match(/^#+/)[0].length; out.push('<h' + lvl + '>' + mdInline(line.replace(/^#+\\s*/, '')) + '</h' + lvl + '>'); i++; continue; }
    if (/^\\s*([-*])\\s+/.test(line)) { flushP(); if (inList !== 'ul') { flushL(); out.push('<ul>'); inList = 'ul'; } out.push('<li>' + mdInline(line.replace(/^\\s*[-*]\\s+/, '')) + '</li>'); i++; continue; }
    if (/^\\s*\\d+[.)]\\s+/.test(line)) { flushP(); if (inList !== 'ol') { flushL(); out.push('<ol>'); inList = 'ol'; } out.push('<li>' + mdInline(line.replace(/^\\s*\\d+[.)]\\s+/, '')) + '</li>'); i++; continue; }
    if (/^\\s*>\\s?/.test(line)) { flushP(); flushL(); out.push('<blockquote>' + mdInline(line.replace(/^\\s*>\\s?/, '')) + '</blockquote>'); i++; continue; }
    if (/^\\s*(---|\\*\\*\\*)\\s*$/.test(line)) { flushP(); flushL(); out.push('<hr>'); i++; continue; }
    if (/^\\s*$/.test(line)) { flushP(); flushL(); i++; continue; }
    buf.push(line); i++;
  }
  flushP(); flushL();
  return out.join('');
}
document.addEventListener('click', function(ev){
  var b = ev.target.closest ? ev.target.closest('[data-copy]') : null;
  if (!b) return;
  var code = b.parentElement.querySelector('code');
  navigator.clipboard.writeText(code ? code.textContent : '').then(function(){ b.textContent = '✓'; setTimeout(function(){ b.textContent = 'Copy'; }, 1200); });
});

/* ---------- SSE reader ---------- */
function readSSE(res, onEvent) {
  var reader = res.body.getReader(); var dec = new TextDecoder(); var buf = ''; var event = '';
  function pump() {
    return reader.read().then(function(r){
      if (r.done) return;
      buf += dec.decode(r.value, { stream: true });
      var nl;
      while ((nl = buf.indexOf('\\n')) >= 0) {
        var line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line.indexOf('event:') === 0) { event = line.slice(6).trim(); continue; }
        if (line.indexOf('data:') !== 0) continue;
        var data; try { data = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        onEvent(event, data);
      }
      return pump();
    });
  }
  return pump();
}

function fileToB64(file) {
  return new Promise(function(resolve, reject){
    var rd = new FileReader();
    rd.onload = function(){ resolve(String(rd.result).split(',')[1]); };
    rd.onerror = reject;
    rd.readAsDataURL(file);
  });
}
`
