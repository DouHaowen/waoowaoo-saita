import { getProviderConfig } from '@/lib/api-config'
import { normalizeFalProviderInputUrl } from '@/lib/lipsync/providers/fal'
import type { LipSyncParams, LipSyncResult, LipSyncSubmitContext } from '@/lib/lipsync/types'

function encodeProviderToken(providerId: string): string {
  return `b64_${Buffer.from(providerId, 'utf8').toString('base64url')}`
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function parseDataUrl(input: string): { mimeType: string; buffer: Buffer } | null {
  if (!input.startsWith('data:')) return null
  const marker = input.indexOf(',')
  if (marker <= 5) return null
  const header = input.slice(5, marker)
  if (!header.includes(';base64')) return null
  const mimeType = header.split(';')[0] || 'application/octet-stream'
  return {
    mimeType,
    buffer: Buffer.from(input.slice(marker + 1), 'base64'),
  }
}

function appendMediaInput(form: FormData, field: 'video' | 'audio', value: string): void {
  const dataUrl = parseDataUrl(value)
  if (dataUrl) {
    const extension = dataUrl.mimeType.includes('audio') ? 'wav' : 'mp4'
    form.append(field, new Blob([new Uint8Array(dataUrl.buffer)], { type: dataUrl.mimeType }), `input.${extension}`)
    return
  }
  form.append(`${field}_url`, value)
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const rawText = await response.text().catch(() => '')
  try {
    return rawText.trim() ? JSON.parse(rawText) as Record<string, unknown> : {}
  } catch {
    return { error: rawText.trim() }
  }
}

export async function submitLatentSyncLipSync(
  params: LipSyncParams,
  context: LipSyncSubmitContext,
): Promise<LipSyncResult> {
  const { apiKey, baseUrl } = await getProviderConfig(context.userId, context.providerId)
  const endpointBase = normalizeBaseUrl(readTrimmedString(baseUrl))
  if (!endpointBase) {
    throw new Error('LATENTSYNC_BASE_URL_REQUIRED')
  }

  const videoUrl = await normalizeFalProviderInputUrl(params.videoUrl, 'video_url')
  const audioUrl = await normalizeFalProviderInputUrl(params.audioUrl, 'audio_url')
  const form = new FormData()
  appendMediaInput(form, 'video', videoUrl)
  appendMediaInput(form, 'audio', audioUrl)
  form.append('inference_steps', '20')
  form.append('guidance_scale', '1.5')

  const headers: HeadersInit = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(`${endpointBase}/lip-sync`, {
    method: 'POST',
    headers,
    body: form,
  })
  const payload = await parseJsonResponse(response)
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : typeof payload.error === 'string' ? payload.error : ''
    throw new Error(detail || `LATENTSYNC_API_ERROR: ${response.status}`)
  }

  const jobId = typeof payload.jobId === 'string' ? payload.jobId : ''
  if (!jobId) {
    throw new Error('LATENTSYNC_API_INVALID_RESPONSE: missing jobId')
  }

  const providerToken = encodeProviderToken(context.providerId)
  return {
    requestId: jobId,
    externalId: `LATENTSYNC:VIDEO:${providerToken}:${jobId}`,
    async: true,
  }
}
