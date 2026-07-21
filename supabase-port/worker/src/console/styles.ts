// Design system CSS for the admin console. Light/dark via CSS variables;
// [data-theme] set by the in-app toggle wins over the system preference.
export const consoleStyles = `
  :root {
    --bg: #f6f7fb; --bg2: #ffffff; --card: #ffffff; --border: #e4e6ef;
    --text: #17182b; --muted: #6b7280; --primary: #6366f1; --primary-soft: #eef0ff;
    --success: #059669; --success-soft: #d1fae5; --warn: #b45309; --warn-soft: #fef3c7;
    --danger: #dc2626; --danger-soft: #fee2e2; --shadow: 0 1px 3px rgba(16,18,35,.07), 0 4px 14px rgba(16,18,35,.05);
    --r: 12px; --r-sm: 8px;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1117; --bg2: #161925; --card: #1a1e2c; --border: #2a2f42;
      --text: #e7e9f2; --muted: #8b91a7; --primary: #818cf8; --primary-soft: #262b45;
      --success: #34d399; --success-soft: #123528; --warn: #fbbf24; --warn-soft: #3a2c10;
      --danger: #f87171; --danger-soft: #3d1a1a; --shadow: 0 1px 3px rgba(0,0,0,.4);
      color-scheme: dark;
    }
  }
  :root[data-theme="light"] {
    --bg: #f6f7fb; --bg2: #ffffff; --card: #ffffff; --border: #e4e6ef;
    --text: #17182b; --muted: #6b7280; --primary: #6366f1; --primary-soft: #eef0ff;
    --success: #059669; --success-soft: #d1fae5; --warn: #b45309; --warn-soft: #fef3c7;
    --danger: #dc2626; --danger-soft: #fee2e2; --shadow: 0 1px 3px rgba(16,18,35,.07), 0 4px 14px rgba(16,18,35,.05);
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: #0f1117; --bg2: #161925; --card: #1a1e2c; --border: #2a2f42;
    --text: #e7e9f2; --muted: #8b91a7; --primary: #818cf8; --primary-soft: #262b45;
    --success: #34d399; --success-soft: #123528; --warn: #fbbf24; --warn-soft: #3a2c10;
    --danger: #f87171; --danger-soft: #3d1a1a; --shadow: 0 1px 3px rgba(0,0,0,.4);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; display: flex; height: 100dvh; background: var(--bg); color: var(--text);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  ::selection { background: var(--primary); color: #fff; }

  /* ---- sidebar ---- */
  #side {
    width: 224px; flex: none; background: var(--bg2); border-right: 1px solid var(--border);
    padding: 14px 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
  }
  #side .brand { font-weight: 700; font-size: 15px; padding: 4px 10px 10px; display: flex; align-items: center; gap: 8px; }
  #side .brand .dot { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--primary), #a855f7); display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 14px; }
  #side select { margin: 0 6px 10px; }
  #side .nav {
    display: flex; align-items: center; gap: 9px; text-align: left; padding: 8px 11px; border: 0;
    background: none; color: var(--text); border-radius: var(--r-sm); cursor: pointer; font-size: 13.5px; width: 100%;
  }
  #side .nav:hover { background: var(--primary-soft); }
  #side .nav.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
  #side .nav .ic { width: 18px; text-align: center; }
  #side .sep { margin: 8px 12px; border-top: 1px solid var(--border); }
  #side .foot { margin-top: auto; padding: 8px 6px 2px; }

  /* ---- main ---- */
  #main { flex: 1; overflow-y: auto; padding: 22px 26px 40px; }
  .pagehead { display: flex; align-items: center; gap: 12px; margin: 0 0 16px; flex-wrap: wrap; }
  .pagehead h1 { font-size: 19px; margin: 0; font-weight: 700; }
  .pagehead .spacer { flex: 1; }
  .sub { color: var(--muted); font-size: 12.5px; }

  /* ---- primitives ---- */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; box-shadow: var(--shadow); }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .grid { display: grid; gap: 14px; }
  .grid.cols3 { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .grid.cols4 { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }

  .btn {
    display: inline-flex; align-items: center; gap: 7px; padding: 8px 15px; border-radius: var(--r-sm);
    border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer;
    font-size: 13.5px; font-weight: 500; transition: transform .05s, background .15s, border-color .15s;
  }
  .btn:hover { border-color: var(--primary); color: var(--primary); }
  .btn:active { transform: scale(.97); }
  .btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  .btn.primary:hover { filter: brightness(1.08); color: #fff; }
  .btn.danger { color: var(--danger); }
  .btn.danger:hover { background: var(--danger-soft); border-color: var(--danger); }
  .btn.sm { padding: 5px 10px; font-size: 12.5px; }
  .btn:disabled { opacity: .5; pointer-events: none; }

  input, select, textarea {
    padding: 8px 11px; border: 1px solid var(--border); border-radius: var(--r-sm);
    background: var(--bg2); color: var(--text); font: inherit; font-size: 13.5px;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
  textarea { width: 100%; resize: vertical; font-family: inherit; }
  textarea.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.5; }
  label.f { display: block; margin: 12px 0 0; }
  label.f > span { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 5px; color: var(--muted); }
  label.f input, label.f select { width: 100%; }
  .hint { font-size: 11.5px; color: var(--muted); margin-top: 4px; }

  .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
  .badge.ok { background: var(--success-soft); color: var(--success); }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .badge.err { background: var(--danger-soft); color: var(--danger); }
  .badge.info { background: var(--primary-soft); color: var(--primary); }
  .badge.mut { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }

  table.t { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.t th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--border); }
  table.t td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  table.t tr:last-child td { border-bottom: 0; }
  table.t tr.click { cursor: pointer; }
  table.t tr.click:hover td { background: var(--primary-soft); }

  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 16px; flex-wrap: wrap; }
  .tabs button { border: 0; background: none; color: var(--muted); padding: 9px 15px; cursor: pointer; font-size: 13.5px; font-weight: 500; border-bottom: 2px solid transparent; }
  .tabs button.on { color: var(--primary); border-bottom-color: var(--primary); font-weight: 600; }

  .empty { text-align: center; color: var(--muted); padding: 44px 20px; }
  .empty .big { font-size: 34px; margin-bottom: 10px; }
  .skl { position: relative; overflow: hidden; background: var(--border); border-radius: var(--r-sm); min-height: 14px; }
  .skl::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.25), transparent); animation: shim 1.2s infinite; }
  @keyframes shim { to { transform: translateX(100%); } }

  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); cursor: pointer; font-size: 12.5px; }
  .chip:hover { border-color: var(--primary); color: var(--primary); }

  /* ---- modal ---- */
  .ovl { position: fixed; inset: 0; background: rgba(10,12,20,.5); display: flex; align-items: center; justify-content: center; z-index: 60; animation: fade .12s; }
  @keyframes fade { from { opacity: 0; } }
  .modal { background: var(--card); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); width: min(560px, 92vw); max-height: 86vh; display: flex; flex-direction: column; animation: pop .14s; }
  @keyframes pop { from { transform: scale(.96); opacity: 0; } }
  .modal .mh { padding: 15px 18px 0; font-weight: 700; font-size: 15px; }
  .modal .mb { padding: 12px 18px; overflow-y: auto; }
  .modal .mf { padding: 12px 18px 16px; display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid var(--border); }
  .modal.wide { width: min(820px, 94vw); }

  /* ---- toast ---- */
  #toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 80; }
  .toast { background: var(--card); color: var(--text); border: 1px solid var(--border); border-left: 3px solid var(--primary); box-shadow: var(--shadow); padding: 11px 15px; border-radius: 10px; max-width: 46ch; font-size: 13px; animation: slidein .18s; }
  .toast.ok { border-left-color: var(--success); }
  .toast.err { border-left-color: var(--danger); }
  @keyframes slidein { from { transform: translateY(8px); opacity: 0; } }

  /* ---- chat ---- */
  .chatwrap { display: flex; flex-direction: column; height: calc(100dvh - 150px); }
  #chatlog { flex: 1; overflow-y: auto; padding: 6px 2px 12px; }
  .msg { display: flex; gap: 10px; margin: 10px 0; max-width: 88%; }
  .msg .av { width: 30px; height: 30px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 15px; background: var(--primary-soft); }
  .msg .bub { padding: 10px 14px; border-radius: 14px; background: var(--card); border: 1px solid var(--border); overflow-wrap: anywhere; }
  .msg.user { margin-left: auto; flex-direction: row-reverse; }
  .msg.user .bub { background: var(--primary); color: #fff; border-color: var(--primary); }
  .msg.user .av { background: var(--primary); color: #fff; }
  .msg .bub .cursor { display: inline-block; width: 7px; height: 15px; background: var(--primary); vertical-align: -2px; animation: blink 1s steps(1) infinite; border-radius: 2px; }
  @keyframes blink { 50% { opacity: 0; } }
  .msg .toolinfo { font-size: 12px; margin-top: 6px; }
  .msg details { border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin-top: 6px; background: var(--bg); }
  .msg details summary { cursor: pointer; font-size: 12px; color: var(--muted); }
  .chatbar { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
  .chatbar textarea { flex: 1; max-height: 130px; border-radius: 12px; }
  .attachrow { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .attachrow .att { position: relative; }
  .attachrow img { height: 52px; border-radius: 8px; border: 1px solid var(--border); }
  .attachrow .x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; background: var(--danger); color: #fff; border: 0; font-size: 10px; cursor: pointer; line-height: 1; }

  /* ---- markdown ---- */
  .md p { margin: 0 0 8px; } .md p:last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3 { margin: 10px 0 6px; line-height: 1.3; }
  .md h1 { font-size: 17px; } .md h2 { font-size: 15.5px; } .md h3 { font-size: 14px; }
  .md ul, .md ol { margin: 4px 0 8px; padding-left: 22px; }
  .md li { margin: 2px 0; }
  .md code { background: var(--bg); border: 1px solid var(--border); padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, monospace; font-size: 12px; }
  .msg.user .bub code { background: rgba(255,255,255,.18); border-color: transparent; color: #fff; }
  .md pre { background: var(--bg); border: 1px solid var(--border); border-radius: 9px; padding: 11px 13px; overflow-x: auto; position: relative; margin: 8px 0; }
  .md pre code { background: none; border: 0; padding: 0; font-size: 12.5px; display: block; white-space: pre; }
  .md pre .cp { position: absolute; top: 6px; right: 6px; font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--muted); cursor: pointer; }
  .md blockquote { border-left: 3px solid var(--primary); margin: 6px 0; padding: 2px 12px; color: var(--muted); }
  .md a { color: var(--primary); }
  .md hr { border: 0; border-top: 1px solid var(--border); margin: 10px 0; }

  /* ---- workflow canvas ---- */
  .wf-wrap { display: flex; gap: 14px; height: calc(100dvh - 130px); }
  .wf-canvas { flex: 1; overflow: hidden; border: 1px solid var(--border); border-radius: var(--r); background: var(--bg2); position: relative; }
  .wf-canvas svg { display: block; cursor: grab; }
  .wf-canvas .zoombar { position: absolute; bottom: 10px; left: 10px; display: flex; gap: 4px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 3px; }
  .wf-canvas .zoombar button { border: 0; background: none; color: var(--text); width: 28px; height: 26px; cursor: pointer; border-radius: 6px; }
  .wf-canvas .zoombar button:hover { background: var(--primary-soft); }
  .wf-side { width: 330px; flex: none; overflow-y: auto; }

  /* ---- stat cards ---- */
  .stat { padding: 15px 16px; }
  .stat .n { font-size: 24px; font-weight: 700; }
  .stat .l { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .usagebar { height: 8px; border-radius: 5px; background: var(--bg); overflow: hidden; margin-top: 6px; }
  .usagebar > i { display: block; height: 100%; background: var(--primary); border-radius: 5px; }

  @media (max-width: 860px) {
    #side { position: fixed; z-index: 50; height: 100dvh; transform: translateX(-100%); transition: transform .18s; }
    #side.open { transform: none; }
    #main { padding: 14px; }
    #menubtn { display: inline-flex !important; }
    .wf-wrap { flex-direction: column; height: auto; }
    .wf-side { width: auto; }
    .wf-canvas { height: 55vh; }
  }
  #menubtn { display: none; position: fixed; top: 10px; left: 10px; z-index: 55; }
`
