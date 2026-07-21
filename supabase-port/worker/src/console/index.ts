import { consoleStyles } from './styles'
import { clientLib } from './clientlib'
import { appJs } from './app'
import { appJs2 } from './app2'

// Admin console — single-page app assembled from the design system, shared
// client runtime and view logic. Served at `/` with zero build tooling.
export const consoleHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coze Supabase Port — Console</title>
<style>${consoleStyles}</style>
</head>
<body>
<button id="menubtn" class="btn">☰</button>
<div id="side"></div>
<div id="main"></div>
<div id="toasts"></div>
<script>
${clientLib}
${appJs}
${appJs2}
</script>
</body>
</html>`
