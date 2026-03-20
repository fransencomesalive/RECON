import fs from 'fs'
import path from 'path'
import type { CanonicalRoute, ReconResult } from './types'

// ─── Storage abstraction ──────────────────────────────────────────────────────
// Uses Upstash Redis in production (when KV_REST_API_URL is set).
// Falls back to filesystem storage for local development — the filesystem
// is shared across all Next.js route handler contexts, unlike globalThis which
// is isolated per-bundle in App Router dev mode.
//
// To set up Upstash Redis on Vercel:
//   1. Go to vercel.com/marketplace → search "Upstash Redis" → Add
//   2. Connect the integration to this project
//   3. Vercel auto-populates KV_REST_API_URL + KV_REST_API_TOKEN
//   4. Pull env vars locally: npx vercel env pull
// ─────────────────────────────────────────────────────────────────────────────

const TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// ─── Dev filesystem store ─────────────────────────────────────────────────────

const DEV_STORE_DIR = path.join(process.cwd(), '.next', 'recon-dev-store')

function devPath(key: string): string {
  // Sanitize key for safe filesystem use
  return path.join(DEV_STORE_DIR, key.replace(/[^a-zA-Z0-9\-]/g, '_') + '.json')
}

function devSet(key: string, value: string): void {
  fs.mkdirSync(DEV_STORE_DIR, { recursive: true })
  fs.writeFileSync(devPath(key), value, 'utf-8')
}

function devGet(key: string): string | null {
  try {
    return fs.readFileSync(devPath(key), 'utf-8')
  } catch {
    return null
  }
}

// ─── Redis ────────────────────────────────────────────────────────────────────

function isRedisConfigured(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

async function getRedis() {
  const { Redis } = await import('@upstash/redis')
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function storeResult(result: ReconResult): Promise<void> {
  if (isRedisConfigured()) {
    const redis = await getRedis()
    await redis.set(`recon:${result.id}`, JSON.stringify(result), { ex: TTL_SECONDS })
  } else {
    devSet(result.id, JSON.stringify(result))
  }
}

export async function getResult(id: string): Promise<ReconResult | null> {
  if (isRedisConfigured()) {
    const redis = await getRedis()
    const raw = await redis.get<string>(`recon:${id}`)
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } else {
    const raw = devGet(id)
    return raw ? JSON.parse(raw) : null
  }
}

export async function storeRoute(id: string, route: CanonicalRoute): Promise<void> {
  if (isRedisConfigured()) {
    const redis = await getRedis()
    await redis.set(`recon:route:${id}`, JSON.stringify(route), { ex: TTL_SECONDS })
  } else {
    devSet(`route_${id}`, JSON.stringify(route))
  }
}

export async function getRoute(id: string): Promise<CanonicalRoute | null> {
  if (isRedisConfigured()) {
    const redis = await getRedis()
    const raw = await redis.get<string>(`recon:route:${id}`)
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } else {
    const raw = devGet(`route_${id}`)
    return raw ? JSON.parse(raw) : null
  }
}
