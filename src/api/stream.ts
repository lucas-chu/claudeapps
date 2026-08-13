import type { ApiMessage } from '../state/context'
import type { Source } from '../state/types'

export type StreamHandlers = {
  onDelta: (text: string) => void
  onSources: (sources: Source[]) => void
  onError: (message: string) => void
  onDone: () => void
}

/** Parses whole SSE events from a buffer. A trailing partial event is ignored. */
export function parseSSE(buffer: string): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = []
  const chunks = buffer.split('\n\n')
  // The final chunk is either empty or an incomplete event; never parse it.
  for (const chunk of chunks.slice(0, -1)) {
    const eventLine = chunk.match(/^event: (.*)$/m)
    const dataLine = chunk.match(/^data: (.*)$/m)
    if (!eventLine || !dataLine) continue
    try {
      out.push({ event: eventLine[1], data: JSON.parse(dataLine[1]) })
    } catch {
      // Malformed payload: skip rather than break the stream.
    }
  }
  return out
}

export async function generate(
  messages: ApiMessage[],
  handlers: StreamHandlers,
): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    })
  } catch (err) {
    handlers.onError(`Could not reach the server: ${(err as Error).message}`)
    return
  }

  if (!response.ok || !response.body) {
    handlers.onError(`Server returned ${response.status}`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let errored = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const events = parseSSE(buffer)
    // Retain only the trailing partial event.
    const lastBreak = buffer.lastIndexOf('\n\n')
    if (lastBreak !== -1) buffer = buffer.slice(lastBreak + 2)

    for (const { event, data } of events) {
      if (event === 'delta') handlers.onDelta(data.text)
      else if (event === 'sources') handlers.onSources(data.sources)
      else if (event === 'error') {
        errored = true
        handlers.onError(data.message)
      }
    }
  }

  if (!errored) handlers.onDone()
}
