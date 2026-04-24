import { BaseVideoGenerator, type GenerateResult, type VideoGenerateParams } from './base'
import { getProviderConfig } from '@/lib/api-config'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'

interface LtxVideoOptions {
  modelId?: string
  duration?: number
  fps?: number
  aspectRatio?: string
  generateAudio?: boolean
}

type LtxDimensions = { width: number; height: number }

const DEFAULT_FPS = 16
const DEFAULT_MODEL_ID = 'ltx-2.3'

function encodeProviderToken(providerId: string): string {
  return `b64_${Buffer.from(providerId, 'utf8').toString('base64url')}`
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  return {
    mimeType: match[1] || 'application/octet-stream',
    base64: match[2],
  }
}

function normalizeFrames(totalFrames: number): number {
  const value = Math.max(totalFrames, 9)
  const remainder = (value - 1) % 8
  if (remainder === 0) return value
  return value + (8 - remainder)
}

function resolveNumFrames(duration: unknown, fps: number): number {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return 9
  }
  return normalizeFrames(Math.round(duration * fps) + 1)
}

function resolveDimensions(aspectRatio: unknown): LtxDimensions {
  switch (aspectRatio) {
    case '9:16':
    case '2:3':
      return { width: 512, height: 896 }
    case '1:1':
      return { width: 640, height: 640 }
    case '4:3':
      return { width: 768, height: 576 }
    case '3:4':
      return { width: 576, height: 768 }
    case '3:2':
      return { width: 768, height: 512 }
    case '2:1':
      return { width: 896, height: 448 }
    case '21:9':
      return { width: 1024, height: 448 }
    case '9:21':
      return { width: 448, height: 1024 }
    case '16:9':
    default:
      return { width: 896, height: 512 }
  }
}

function buildBaseUrl(rawBaseUrl?: string): string {
  const value = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim().replace(/\/+$/, '') : ''
  if (!value) {
    throw new Error('LTX_BASE_URL_REQUIRED')
  }
  return value
}

export class LtxVideoGenerator extends BaseVideoGenerator {
  protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
    const { userId, imageUrl, prompt = '', options = {} } = params
    const providerId = typeof options.provider === 'string' ? options.provider : 'ltx'
    const { apiKey, baseUrl } = await getProviderConfig(userId, providerId)
    const resolvedBaseUrl = buildBaseUrl(baseUrl)

    const {
      modelId = DEFAULT_MODEL_ID,
      duration,
      fps: rawFps,
      aspectRatio,
      generateAudio,
    } = options as LtxVideoOptions

    if (modelId !== DEFAULT_MODEL_ID) {
      throw new Error(`LTX_VIDEO_OPTION_UNSUPPORTED: modelId=${String(modelId)}`)
    }
    if (generateAudio !== undefined && typeof generateAudio !== 'boolean') {
      throw new Error(`LTX_VIDEO_OPTION_INVALID: generateAudio=${String(generateAudio)}`)
    }

    const fps = typeof rawFps === 'number' && Number.isFinite(rawFps) && rawFps > 0
      ? Math.round(rawFps)
      : DEFAULT_FPS
    const { width, height } = resolveDimensions(aspectRatio)
    const numFrames = resolveNumFrames(duration, fps)

    const base64DataUrl = imageUrl.startsWith('data:') ? imageUrl : await normalizeToBase64ForGeneration(imageUrl)
    const parsed = parseDataUrl(base64DataUrl)
    if (!parsed) {
      throw new Error('LTX_INPUT_IMAGE_INVALID')
    }

    const imageBytes = Buffer.from(parsed.base64, 'base64')
    const formData = new FormData()
    formData.append('prompt', prompt.trim() || 'A realistic cinematic shot with subtle natural motion.')
    formData.append('width', String(width))
    formData.append('height', String(height))
    formData.append('num_frames', String(numFrames))
    formData.append('frame_rate', String(fps))
    formData.append('generate_audio', String(generateAudio !== false))
    formData.append('token', apiKey)
    formData.append('image', new Blob([imageBytes], { type: parsed.mimeType }), 'input.png')

    const response = await fetch(`${resolvedBaseUrl}/generate`, {
      method: 'POST',
      body: formData,
    })

    const rawText = await response.text().catch(() => '')
    let payload: Record<string, unknown> | null = null
    if (rawText.trim()) {
      try {
        payload = JSON.parse(rawText) as Record<string, unknown>
      } catch {
        payload = null
      }
    }

    if (!response.ok) {
      const errorDetail = payload?.detail
      const errorMessage = typeof errorDetail === 'string'
        ? errorDetail
        : rawText.trim() || `LTX_API_ERROR: ${response.status}`
      throw new Error(errorMessage)
    }

    const jobId = typeof payload?.jobId === 'string' ? payload.jobId.trim() : ''
    if (!jobId) {
      throw new Error('LTX_API_INVALID_RESPONSE: missing jobId')
    }

    const providerToken = encodeProviderToken(providerId)
    return {
      success: true,
      async: true,
      requestId: jobId,
      externalId: `LTX:VIDEO:${providerToken}:${jobId}`,
    }
  }
}
