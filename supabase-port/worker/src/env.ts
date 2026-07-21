import type { SupabaseClient } from '@supabase/supabase-js'

export interface IndexJob {
  documentId: string
  workspaceId: string
}

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  SUPABASE_JWT_SECRET: string
  OPENAI_API_KEY: string
  OPENAI_BASE_URL?: string
  JINA_API_KEY: string
  JINA_BASE_URL?: string
  CHAT_MODEL?: string
  EMBEDDING_MODEL?: string
  EMBEDDING_DIM?: string
  RERANK_MODEL?: string
  INDEX_QUEUE?: Queue<IndexJob>
}

export interface Vars {
  supabase: SupabaseClient
  userId: string
  authKind: 'user' | 'api_key'
  apiKeyWorkspaceId?: string
  wsRole?: string
}

export type AppEnv = { Bindings: Env; Variables: Vars }
