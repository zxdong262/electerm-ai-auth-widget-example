/**
 * Turning a Responses SSE stream back into the single JSON object the same
 * endpoint returns when `stream` is false.
 *
 * Why this is needed: the ChatGPT subscription backend refuses `stream: false`
 * ("Stream must be set to true"), but several electerm features ask for a
 * non-streaming answer -- the agent loop (`AIchatWithTools`, which is how tools
 * are called), AI bookmarks, theme generation, quick commands, and command
 * suggestions. The proxy therefore always asks upstream to stream and, for a
 * caller that wanted one object, folds the events back together here.
 *
 * The fold prefers the provider's own final object: every Responses stream ends
 * with `response.completed` (or `response.incomplete`) carrying the full
 * Response, which is exactly what the non-streaming endpoint would have
 * returned. The event-by-event rebuild below is the fallback for a stream that
 * ends early, so a truncated answer still arrives as text plus whatever tool
 * calls were complete.
 */

function parseEvents (text) {
  const events = []
  let name = ''
  let data = []

  function flush () {
    if (data.length) {
      const payload = data.join('\n')
      if (payload && payload !== '[DONE]') {
        try {
          const parsed = JSON.parse(payload)
          if (parsed && typeof parsed === 'object') {
            events.push({ event: name, data: parsed })
          }
        } catch (e) {
          // a comment or a non-JSON keepalive: nothing to fold
        }
      }
    }
    name = ''
    data = []
  }

  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw === '') {
      flush()
      continue
    }
    if (raw.startsWith(':')) {
      continue
    }
    // some relays send raw JSON lines without the `data:` prefix
    if (raw.startsWith('{')) {
      data.push(raw)
      continue
    }
    const colon = raw.indexOf(':')
    const field = colon === -1 ? raw : raw.slice(0, colon)
    let value = colon === -1 ? '' : raw.slice(colon + 1)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }
    if (field === 'event') {
      name = value
    } else if (field === 'data') {
      data.push(value)
    }
  }
  flush()
  return events
}

function itemAt (items, index) {
  let item = items.get(index)
  if (!item) {
    item = { type: 'message', role: 'assistant', content: [] }
    items.set(index, item)
  }
  return item
}

function indexOf (data, items) {
  if (typeof data.output_index === 'number') {
    return data.output_index
  }
  // no index on the event: the only sane guess is the last item opened
  const keys = [...items.keys()]
  return keys.length ? keys[keys.length - 1] : 0
}

function hasText (item) {
  return !!(
    item &&
    Array.isArray(item.content) &&
    item.content.some(part => part && typeof part.text === 'string' && part.text)
  )
}

function textPart (item, contentIndex) {
  if (!Array.isArray(item.content)) {
    item.content = []
  }
  const index = typeof contentIndex === 'number' ? contentIndex : 0
  let part = item.content[index]
  if (!part || typeof part !== 'object') {
    part = { type: 'output_text', text: '' }
    item.content[index] = part
  }
  if (typeof part.text !== 'string') {
    part.text = ''
  }
  return part
}

function collapseResponsesStream (text, { model = '' } = {}) {
  const items = new Map()
  let base = null
  let failure = ''

  for (const { data } of parseEvents(text)) {
    const type = data.type || ''
    if (type === 'response.created' || type === 'response.in_progress') {
      if (!base && data.response && typeof data.response === 'object') {
        base = data.response
      }
      continue
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const index = indexOf(data, items)
      const item = data.item && typeof data.item === 'object' ? data.item : null
      if (item) {
        const previous = items.get(index) || {}
        // `added` carries a skeleton and must not wipe text that a relay sent
        // ahead of it; `done` is authoritative and must not be wiped either.
        const merged = type.endsWith('done')
          ? { ...previous, ...item }
          : { ...item, ...previous }
        if (hasText(previous) && !hasText(merged)) {
          merged.content = previous.content
        }
        items.set(index, merged)
      }
      continue
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const item = itemAt(items, indexOf(data, items))
      const part = textPart(item, data.content_index)
      if (type.endsWith('delta')) {
        if (typeof data.delta === 'string') {
          part.text += data.delta
        }
      } else if (typeof data.text === 'string') {
        part.text = data.text
      }
      continue
    }
    if (type === 'response.function_call_arguments.delta' ||
      type === 'response.function_call_arguments.done') {
      const item = itemAt(items, indexOf(data, items))
      if (item.type !== 'function_call') {
        item.type = 'function_call'
      }
      if (typeof item.arguments !== 'string') {
        item.arguments = ''
      }
      if (type.endsWith('delta')) {
        if (typeof data.delta === 'string') {
          item.arguments += data.delta
        }
      } else if (typeof data.arguments === 'string') {
        item.arguments = data.arguments
      }
      continue
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      if (data.response && typeof data.response === 'object') {
        return { response: data.response }
      }
      continue
    }
    if (type === 'response.failed') {
      const error = (data.response && data.response.error) || data.error || {}
      failure = error.message || 'The provider reported a failed response'
      continue
    }
    if (type === 'error' || data.error) {
      const error = data.error || {}
      failure = error.message || String(error) || 'The provider reported an error'
    }
  }

  if (failure) {
    return { error: failure }
  }

  const output = [...items.keys()]
    .sort((a, b) => a - b)
    .map(key => items.get(key))
    .filter(item => item && item.type)

  if (!output.length) {
    return { error: 'The provider closed the stream without returning a response' }
  }

  // The stream ended before `response.completed`. Report it as incomplete
  // rather than as a finished answer: electerm turns that into "AI response
  // incomplete" when there is no usable text, and still shows the text when
  // there is.
  return {
    response: {
      ...(base || {}),
      object: 'response',
      id: (base && base.id) || 'resp_proxy_rebuilt',
      model: (base && base.model) || model,
      status: 'incomplete',
      incomplete_details: { reason: 'stream_closed' },
      output,
      usage: (base && base.usage) || null
    }
  }
}

module.exports = { collapseResponsesStream, parseEvents }
