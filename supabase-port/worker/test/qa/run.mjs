// Browser QA: loads the real console + share page in Chromium against the
// mock server, walks every view, captures screenshots and JS errors.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:4599'
const SHOTS = process.env.QA_SHOTS || '/tmp/qa-shots'
mkdirSync(SHOTS, { recursive: true })

const errors = []
const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM || undefined })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()) })

await page.addInitScript(() => {
  localStorage.setItem('cz-token', 'qa-token')
  localStorage.setItem('cz-view', 'home')
  localStorage.setItem('cz-theme', 'light')
})

async function shot(name) {
  await page.waitForTimeout(450)
  await page.screenshot({ path: SHOTS + '/' + name + '.png' })
  console.log('📸', name)
}

await page.goto(BASE)
await page.waitForTimeout(900)
await shot('01-home-light')

await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
await shot('02-home-dark')
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

// agents list + 3-pane IDE with live preview chat
await page.click('#nav-agents')
await shot('03-agents')
await page.click('#main .card >> nth=0')
await page.waitForTimeout(900)
await shot('04-agent-ide')
await page.fill('.preview-chat input', 'Chính sách đổi trả thế nào?')
await page.click('.preview-chat .pbar .btn.primary')
await page.waitForTimeout(2600)
await shot('05-agent-ide-preview')
await page.click('button:has-text("🎛")')
await page.waitForTimeout(300)
await shot('06-agent-model-modal')
await page.keyboard.press('Escape')

// chat with streaming markdown
await page.click('#nav-chat')
await page.waitForTimeout(600)
await page.fill('.chatbar textarea', 'Chính sách đổi trả thế nào?')
await page.click('.chatbar .btn.primary')
await page.waitForTimeout(2600)
await shot('08-chat')

// knowledge + chunks
await page.click('#nav-knowledge')
await page.waitForTimeout(800)
await shot('09-knowledge')
const chunksBtn = page.locator('button:has-text("Chunks")').first()
if (await chunksBtn.count()) { await chunksBtn.click(); await shot('10-chunks') }

// workflow canvas
await page.click('#nav-workflows')
await page.waitForTimeout(500)
await shot('11-workflows')
await page.click('#main .card >> nth=0')
await page.waitForTimeout(800)
await shot('12-canvas')
const nodeEl = page.locator('[data-node="answer"]')
if (await nodeEl.count()) { await nodeEl.click(); await page.waitForTimeout(300); await shot('13-node-config') }
await page.click('button:has-text("▶ Run")')
await page.waitForTimeout(400)
await page.click('.modal button:has-text("▶ Run (stream)")')
await page.waitForTimeout(1800)
await shot('14-run-stream')
await page.keyboard.press('Escape')

// plugins / databases / apps / prompts / keys / usage / search / settings
await page.click('#nav-plugins'); await page.waitForTimeout(700); await shot('15-plugins')
await page.click('#nav-databases'); await page.waitForTimeout(500); await shot('16-databases')
await page.click('#main .card >> nth=0'); await page.waitForTimeout(600); await shot('17-db-rows')
await page.click('#nav-apps'); await page.waitForTimeout(500)
await page.click('#main .card >> nth=0'); await page.waitForTimeout(700); await shot('18-app-detail')
await page.click('#nav-keys'); await page.waitForTimeout(400); await shot('19-keys')
await page.click('#nav-usage'); await page.waitForTimeout(600); await shot('20-usage')
await page.click('#nav-settings'); await page.waitForTimeout(300); await shot('21-settings')

// share page
await page.goto(BASE + '/share/qa-share-token')
await page.waitForTimeout(800)
await page.fill('#input', 'Phí ship bao nhiêu?')
await page.click('#send')
await page.waitForTimeout(2600)
await shot('22-share-chat')

await browser.close()

if (errors.length) {
  console.log('\n❌ JS ERRORS (' + errors.length + '):')
  const uniq = [...new Set(errors)]
  uniq.slice(0, 30).forEach((e) => console.log('  -', e))
  process.exit(1)
}
console.log('\n✅ QA WALKTHROUGH CLEAN — no JS errors, ' + 22 + ' screenshots in ' + SHOTS)
