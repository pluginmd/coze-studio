import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv, Env, IndexJob } from './env'
import { auth, requireWorkspace } from './middleware/auth'
import { indexDocument } from './indexer'
import { adminClient } from './lib/supabase'
import { drainIndexQueue } from './lib/queue'
import { consoleHtml } from './console'
import { me } from './routes/me'
import { workspacesRoot, workspaceScoped } from './routes/workspaces'
import { agents } from './routes/agents'
import { conversations } from './routes/conversations'
import { chat } from './routes/chat'
import { knowledge } from './routes/knowledge'
import { workflows } from './routes/workflows'
import { plugins } from './routes/plugins'
import { apikeys } from './routes/apikeys'
import { databases } from './routes/databases'
import { variables } from './routes/variables'
import { prompts } from './routes/prompts'
import { search } from './routes/search'
import { oauthWs, oauthCallback } from './routes/oauth'
import { share } from './routes/share'
import { apps } from './routes/apps'
import { files } from './routes/files'
import { compatV3, compatV1 } from './routes/compat'
import { templates } from './routes/templates'

const app = new Hono<AppEnv>()

app.get('/', (c) => c.html(consoleHtml))
app.get('/healthz', (c) => c.json({ ok: true, service: 'coze-supabase-port' }))

// Public routes: OAuth redirect target (signed state) + shared agent chat.
app.route('/oauth', oauthCallback)
app.route('/share', share)

app.use('/v1/*', cors({ origin: (origin) => origin ?? '*', allowHeaders: ['authorization', 'content-type'] }))
app.use('/v1/*', auth)
app.use('/v3/*', cors({ origin: (origin) => origin ?? '*', allowHeaders: ['authorization', 'content-type'] }))
app.use('/v3/*', auth)
app.route('/v3', compatV3)
app.route('/v1', compatV1)
app.route('/v1', me)
app.route('/v1/workspaces', workspacesRoot)

app.use('/v1/workspaces/:wid', requireWorkspace)
app.use('/v1/workspaces/:wid/*', requireWorkspace)
app.route('/v1/workspaces/:wid', workspaceScoped)
app.route('/v1/workspaces/:wid/agents', agents)
app.route('/v1/workspaces/:wid/conversations', conversations)
app.route('/v1/workspaces/:wid/chat', chat)
app.route('/v1/workspaces/:wid/datasets', knowledge)
app.route('/v1/workspaces/:wid/workflows', workflows)
app.route('/v1/workspaces/:wid/plugins/:pid/oauth', oauthWs)
app.route('/v1/workspaces/:wid/plugins', plugins)
app.route('/v1/workspaces/:wid/api-keys', apikeys)
app.route('/v1/workspaces/:wid/databases', databases)
app.route('/v1/workspaces/:wid/variables', variables)
app.route('/v1/workspaces/:wid/prompts', prompts)
app.route('/v1/workspaces/:wid/search', search)
app.route('/v1/workspaces/:wid/apps', apps)
app.route('/v1/workspaces/:wid/files', files)
app.route('/v1/workspaces/:wid/templates', templates)

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => c.json({ error: String(err?.message ?? err).slice(0, 500) }, 500))

export default {
  fetch: app.fetch,

  // Cloudflare Queue consumer — async document indexing (NSQ replacement).
  async queue(batch: MessageBatch<IndexJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await indexDocument(env, message.body.documentId)
        message.ack()
      } catch {
        message.retry()
      }
    }
  },

  // Cron trigger — drains the Supabase Queues (pgmq) tier when Cloudflare
  // Queues aren't bound (free plan): fully-Supabase async indexing.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.INDEX_QUEUE) return // CF Queues handle async work already
    await drainIndexQueue(env, adminClient(env)).catch(() => undefined)
  },
} satisfies ExportedHandler<Env, IndexJob>
