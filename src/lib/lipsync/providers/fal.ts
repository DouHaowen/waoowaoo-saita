import { submitFalTask } from '@/lib/async-submit'
import { getProviderConfig } from '@/lib/api-config'
import { getPublicBaseUrl } from '@/lib/env'
import { normalizeToOriginalMediaUrl } from '@/lib/media/outbound-image'
import {
  ensureMediaObjectFromStorageKey,
  resolveMediaRefFromLegacyValue,
  resolveStorageKeyFromMediaValue,
} from '@/lib/media/service'
import type { LipSyncParams, LipSyncResult, LipSyncSubmitContext } from '@/lib/lipsync/types'

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.local')
  ) {
    return true
  }

  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false

  const [a, b] = octets
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function getProviderPullBaseUrl(): string {
  const override = readTrimmedString(process.env.PUBLIC_MEDIA_BASE_URL)
  if (override) return override.replace(/\/+$/, '')
  return getPublicBaseUrl().trim().replace(/\/+$/, '')
}

async function normalizeFalProviderInputUrl(rawUrl: string, field: 'video_url' | 'audio_url'): Promise<string> {
  const trimmed = readTrimmedString(rawUrl)
  if (!trimmed) {
    throw new Error(`LIPSYNC_INPUT_URL_INVALID: ${field}`)
  }
  if (trimmed.startsWith('data:')) {
    return trimmed
  }

  const normalized = await normalizeToOriginalMediaUrl(trimmed)
  if (normalized.startsWith('data:')) {
    return normalized
  }

  const directStorageKey = await resolveStorageKeyFromMediaValue(trimmed)
  if (directStorageKey) {
    const mediaRef = await ensureMediaObjectFromStorageKey(directStorageKey)
    return `${getProviderPullBaseUrl()}${mediaRef.url}`
  }

  const normalizedStorageKey = await resolveStorageKeyFromMediaValue(normalized)
  if (normalizedStorageKey) {
    const mediaRef = await ensureMediaObjectFromStorageKey(normalizedStorageKey)
    return `${getProviderPullBaseUrl()}${mediaRef.url}`
  }

  const mediaRef = await resolveMediaRefFromLegacyValue(trimmed)
  if (mediaRef?.url) {
    return `${getProviderPullBaseUrl()}${mediaRef.url}`
  }

  if (normalized.startsWith('/')) {
    return `${getProviderPullBaseUrl()}${normalized}`
  }

  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    throw new Error(`LIPSYNC_INPUT_URL_INVALID: ${field}`)
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`LIPSYNC_INPUT_URL_INVALID: ${field}`)
  }

  if (isPrivateHost(parsed.hostname)) {
    return `${getProviderPullBaseUrl()}${parsed.pathname}${parsed.search}${parsed.hash}`
  }

  return normalized
}

export async function submitFalLipSync(
  params: LipSyncParams,
  context: LipSyncSubmitContext,
): Promise<LipSyncResult> {
  const endpoint = context.modelId.trim()
  if (!endpoint) {
    throw new Error(`LIPSYNC_ENDPOINT_MISSING: ${context.modelKey}`)
  }

  const videoUrl = await normalizeFalProviderInputUrl(params.videoUrl, 'video_url')
  const audioUrl = await normalizeFalProviderInputUrl(params.audioUrl, 'audio_url')

  const { apiKey } = await getProviderConfig(context.userId, context.providerId)
  const requestId = await submitFalTask(endpoint, {
    video_url: videoUrl,
    audio_url: audioUrl,
  }, apiKey)

  return {
    requestId,
    externalId: `FAL:VIDEO:${endpoint}:${requestId}`,
    async: true,
  }
}
