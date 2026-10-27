const test = require('node:test')
const assert = require('node:assert')

const { collapseResponsesStream, parseEvents } = require('../lib/sse')

function sse (events) {
  return events.map(([name, data]) => [
    `event: ${name}`,
    `data: ${JSON.stringify(data)}`,
    ''
  ].join('\n')).join('\n')
}

test('prefers the provider final object from response.completed', () => {
  const final = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  }
  const text = sse([
    ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } }],
    ['response.completed', { type: 'response.completed', response: final }]
  ])
  assert.deepEqual(collapseResponsesStream(text), { response: final })
})

test('rebuilds a response when the stream ends before response.completed', () => {
  const text = sse([
    ['response.created', { type: 'response.created', response: { id: 'resp_2', model: 'gpt-x', output: [] } }],
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] }
    }],
    ['response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: 'partial '
    }],
    ['response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: 'answer'
    }]
  ])
  const { response, error } = collapseResponsesStream(text, { model: 'gpt-x' })
  assert.equal(error, undefined)
  assert.equal(response.status, 'incomplete')
  assert.equal(response.id, 'resp_2')
  assert.equal(response.model, 'gpt-x')
  assert.equal(response.output[0].content[0].text, 'partial answer')
})

test('rebuilds a tool call from argument deltas', () => {
  const text = sse([
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'run', arguments: '' }
    }],
    ['response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"cmd":'
    }],
    ['response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '"ls"}'
    }]
  ])
  const { response } = collapseResponsesStream(text)
  assert.deepEqual(response.output[0], {
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_1',
    name: 'run',
    arguments: '{"cmd":"ls"}'
  })
})

test('reports a failed response as an error', () => {
  const text = sse([
    ['response.failed', {
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'model overloaded' } }
    }]
  ])
  assert.deepEqual(collapseResponsesStream(text), { error: 'model overloaded' })
})

test('reports a bare error event as an error', () => {
  const text = sse([
    ['error', { type: 'error', error: { message: 'quota exceeded' } }]
  ])
  assert.deepEqual(collapseResponsesStream(text), { error: 'quota exceeded' })
})

test('a stream with no events is an error, not an empty answer', () => {
  assert.match(collapseResponsesStream('').error, /without returning a response/)
  assert.match(collapseResponsesStream('event: ping\n\n').error, /without returning a response/)
})

test('parses CRLF, comments, keepalives and raw JSON lines', () => {
  const text = [
    ': keepalive',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"a"}',
    '',
    '{"type":"response.output_text.delta","output_index":0,"delta":"b"}',
    '',
    'data: [DONE]',
    ''
  ].join('\r\n')
  const events = parseEvents(text)
  assert.equal(events.length, 2)
  assert.equal(events[0].data.delta, 'a')
  assert.equal(events[1].data.delta, 'b')
})

test('ignores a data line that is not JSON', () => {
  const events = parseEvents('event: x\ndata: not-json\n\n')
  assert.deepEqual(events, [])
})
