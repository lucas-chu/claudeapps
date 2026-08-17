export type DownscaledImage = { data: string; mime: string; width: number; height: number }

/**
 * Decodes an image file, downscales it so its longest edge is at most
 * `maxEdge` (never upscaling), and re-encodes it as a data URL.
 *
 * This matters for autosave: a raw screenshot paste can be well over 1MB as
 * a data URL, and localStorage caps out around 5MB total, so storing pastes
 * undownscaled would silently break persistence. JPEG at ~0.85 keeps typical
 * pastes small; PNG is kept only for sources that may carry transparency.
 *
 * Non-image files and decode failures resolve to a rejected promise so the
 * caller can ignore them quietly instead of crashing or showing an error box.
 */
export function fileToDownscaledDataUrl(file: File, maxEdge = 1280): Promise<DownscaledImage> {
  if (!file.type.startsWith('image/')) {
    return Promise.reject(new Error('not an image file'))
  }

  return new Promise<DownscaledImage>((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    const cleanup = () => URL.revokeObjectURL(url)

    img.onload = () => {
      try {
        const srcW = img.naturalWidth
        const srcH = img.naturalHeight
        if (!srcW || !srcH) {
          cleanup()
          reject(new Error('image has no natural size'))
          return
        }

        const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
        const width = Math.max(1, Math.round(srcW * scale))
        const height = Math.max(1, Math.round(srcH * scale))

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          cleanup()
          reject(new Error('canvas 2d context unavailable'))
          return
        }
        ctx.drawImage(img, 0, 0, width, height)

        // PNG is the only source format we treat as possibly transparent;
        // everything else re-encodes as JPEG to keep the data URL small.
        const usePng = file.type === 'image/png'
        const mime = usePng ? 'image/png' : 'image/jpeg'
        const data = usePng ? canvas.toDataURL(mime) : canvas.toDataURL(mime, 0.85)

        cleanup()
        resolve({ data, mime, width, height })
      } catch (err) {
        cleanup()
        reject(err instanceof Error ? err : new Error('image decode failed'))
      }
    }

    img.onerror = () => {
      cleanup()
      reject(new Error('image decode failed'))
    }

    img.src = url
  })
}
