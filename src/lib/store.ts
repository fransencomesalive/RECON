import type { ReconResult } from './types'

// ─── Storage abstraction ──────────────────────────────────────────────────────
// Uses Upstash Redis in production (when UPSTASH_REDIS_REST_URL is set),
// falls back to an in-memory Map for local development.
//
// To set up Upstash Redis on Vercel:
//   1. Go to vercel.com/marketplace → search "Upstash Redis" → Add
//   2. Connect the integration to this project
//   3. Vercel auto-populates UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   4. Pull env vars locally: npx vercel env pull
// ─────────────────────────────────────────────────────────────────────────────

const TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// In-memory fallback (local dev only — lost on server restart)
const memStore = new Map<string, string>()

function isRedisConfigured(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

async function getRedis() {
  const { Redis } = await import('@upstash/redis')
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  })
}

export async function storeResult(result: ReconResult): Promise<void> {
  if (isRedisConfigured()) {
    const redis = await getRedis()
    await redis.set(`recon:${result.id}`, JSON.stringify(result), { ex: TTL_SECONDS })
  } else {
    memStore.set(result.id, JSON.stringify(result))
  }
}

export async function getResult(id: string): Promise<ReconResult | null> {
  if (isRedisConfigured()) {
    const redis = await getRedis()
    const raw = await redis.get<string>(`recon:${id}`)
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } else {
    const raw = memStore.get(id)
    return raw ? JSON.parse(raw) : null
  }
}
