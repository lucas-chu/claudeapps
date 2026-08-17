export type DownscaledImage = { data: string; mime: string; width: number; height: number }

/**
 * MIME types every major browser can decode in an <img>, best first.
 *
 * This ordering is load-bearing, not cosmetic. The macOS clipboard commonly
 * offers the same image in several flavours at once, and `image/tiff` is often
 * listed first — but no browser decodes TIFF in an <img>, so taking the first
 * image item on the clipboard fails even when a perfectly good PNG is sitting
 * right behind it. Formats not listed here (tiff, heic, ...) sort last and are
 * only attempted as a last resort.
 */
const DECODE_PREFERENCE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Sorts image candidates so the most reliably decodable formats come first. */
export function sortImageCandidates(files: File[]): File[] {
  const rank = (f: File) => {
    const i = DECODE_PREFERENCE.indexOf(f.type.toLowerCase())
    return i === -1 ? DECODE_PREFERENCE.length : i
  }
  return [...files].sort((a, b) => rank(a) - rank(b))
}

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
      // Name the type: this is the message that surfaces to the user, and
      // "couldn't read that image" with no format is undiagnosable.
      reject(new Error(`browser cannot decode ${file.type || 'unknown type'}`))
    }

    img.src = url
  })
}
