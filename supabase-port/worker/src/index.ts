import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv, Env, IndexJob } from './env'
import { auth, requireWorkspace } from './middleware/auth'
import { indexDocument } from './indexer'
import { playgroundHtml } from './playground'
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

const app = new Hono<AppEnv>()

app.get('/', (c) => c.html(playgroundHtml))
app.get('/healthz', (c) => c.json({ ok: true, service: 'coze-supabase-port' }))

// Public OAuth redirect target (authorized via signed state token).
app.route('/oauth', oauthCallback)

app.use('/v1/*', cors({ origin: (origin) => origin ?? '*', allowHeaders: ['authorization', 'content-type'] }))
app.use('/v1/*', auth)
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
} satisfies ExportedHandler<Env, IndexJob>
