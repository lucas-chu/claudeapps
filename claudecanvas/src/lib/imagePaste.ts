export type DownscaledImage = { data: string; mime: string; width: number; height: number }
export type DownscaledCanvas = { data: string; width: number; height: number }

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

/**
 * HEIC/HEIF is what an iPhone photo actually is, and no browser decodes it in
 * an <img> — it is not merely "last preference", it never works natively.
 * macOS sometimes hands the file over with an empty MIME type, so the filename
 * is checked too.
 */
export function isHeic(file: File): boolean {
  const type = file.type.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') return true
  return type === '' && /\.hei[cf]$/i.test(file.name)
}

/**
 * What the user is told when they drop an iPhone photo in.
 *
 * Claude Canvas runs entirely in the browser with no server of its own, and no
 * browser decodes HEIC in an `<img>`. Conversion used to shell out to macOS's
 * own `sips` via a local server; with the app deployed as static files there
 * is no such server to call. The in-browser WASM decoder that predated `sips`
 * is not a way back — its bundled libheif rejected real iPhone photos with
 * "ERR_LIBHEIF format not supported".
 *
 * So this fails loudly and tells the user the one-step fix, rather than
 * failing obscurely somewhere in the decode path.
 */
export const HEIC_UNSUPPORTED_MESSAGE =
  'HEIC photos can’t be read in the browser. Export the photo as JPEG or PNG and try again.'

function heicToJpegFile(_file: File): Promise<File> {
  return Promise.reject(new Error(HEIC_UNSUPPORTED_MESSAGE))
}

/**
 * True for anything this module can turn into a picture. Use this rather than
 * a bare `type.startsWith('image/')` check: macOS can hand a HEIC over with an
 * empty MIME type, and such a file would otherwise be filtered out before it
 * ever reached the converter.
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || isHeic(file)
}

/** Sorts image candidates so the most reliably decodable formats come first. */
export function sortImageCandidates(files: File[]): File[] {
  const rank = (f: File) => {
    const i = DECODE_PREFERENCE.indexOf(f.type.toLowerCase())
    return i === -1 ? DECODE_PREFERENCE.length : i
  }
  return [...files].sort((a, b) => rank(a) - rank(b))
}

/**
 * Draws `source` (already decoded/rendered — an <img>, a <canvas>, ...) onto
 * a fresh canvas downscaled so its longest edge is at most `maxEdge` (never
 * upscaling), and encodes the result as a data URL.
 *
 * This is the shared 1280px-long-edge convention: `fileToDownscaledDataUrl`
 * below uses it for pasted/dropped images, and the Excalidraw drawing-box
 * preview pipeline (see canvas/ExcalidrawScene.tsx) uses it too, so the rule
 * — and the reason for it (autosave's ~5MB localStorage budget) — lives in
 * exactly one place.
 */
export function downscaleToDataUrl(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  opts: { maxEdge?: number; mime?: 'image/png' | 'image/jpeg'; quality?: number } = {},
): DownscaledCanvas {
  const { maxEdge = 1280, mime = 'image/png', quality } = opts
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(source, 0, 0, width, height)

  const data = quality !== undefined ? canvas.toDataURL(mime, quality) : canvas.toDataURL(mime)
  return { data, width, height }
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
export async function fileToDownscaledDataUrl(
  file: File,
  maxEdge = 1280,
): Promise<DownscaledImage> {
  // HEIC has to be transcoded before anything else can look at it, since the
  // <img> decode path below cannot read it at all.
  if (isHeic(file)) {
    try {
      file = await heicToJpegFile(file)
    } catch (err) {
      // heicToJpegFile always throws a proper Error, but this stays
      // defensive against a non-Error rejection (e.g. a future change to the
      // fetch call) so a real cause is never swallowed as "unknown error".
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err)
      throw new Error(`could not convert HEIC: ${detail}`)
    }
  }

  if (!file.type.startsWith('image/')) {
    throw new Error('not an image file')
  }

  const decodable = file
  return new Promise<DownscaledImage>((resolve, reject) => {
    const file = decodable
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

        // PNG is the only source format we treat as possibly transparent;
        // everything else re-encodes as JPEG to keep the data URL small.
        const usePng = file.type === 'image/png'
        const mime = usePng ? 'image/png' : 'image/jpeg'
        const { data, width, height } = downscaleToDataUrl(img, srcW, srcH, {
          maxEdge, mime, quality: usePng ? undefined : 0.85,
        })

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
