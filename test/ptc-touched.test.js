// A sub-dispatch made inside `run_code` is a log-only `tool/ptc-dispatch` event: it never joins the
// model-visible surface, so `deriveEventMessage` returns null for it and the touched index sees nothing.
// The file it mutated still has to show up there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectMessages } from '../lib/session-source.js'
import { getTouchedFiles } from '../src/core/search-entries.js'
import { formatTouchedOutput } from '../src/core/format-recall.js'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Minimal session stand-in: seq-numbered log, surface nodes, event projection. */
function fakeSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    surface: { nodes: events.filter((event) => SURFACE_TYPES.has(event.type)).map((event) => event.seq) },
    eventAt: (seq) => bySeq.get(seq),
    snapshotEvents: () => events,
    deriveEventMessage: (event) => {
      switch (event.type) {
        case 'user/message':
          return event.data
        case 'assistant/message':
          return event.data.message.content.length === 0 ? null : event.data.message
        case 'tool/result':
          return event.data.message
        default:
          return null
      }
    },
  }
}

const session = fakeSession([
  { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'fix the fixture' }] } },
  {
    seq: 2,
    type: 'assistant/message',
    data: {
      turn: 0,
      step: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'run_code', arguments: '{"code":"await tools.write(...)"}' }],
      },
    },
  },
  { seq: 3, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'wrote a.txt' }] } } },
  {
    seq: 4,
    type: 'tool/ptc-dispatch',
    data: {
      rootCallId: 'call-1',
      parentCallId: 'call-1',
      subCallId: 'call-1:ptc:1',
      name: 'write',
      arguments: { file_path: '/work/a.txt', content: 'one\ntwo\n' },
      isError: false,
      content: [{ type: 'text', text: 'wrote /work/a.txt' }],
    },
  },
  {
    seq: 5,
    type: 'tool/ptc-dispatch',
    data: {
      rootCallId: 'call-1',
      parentCallId: 'call-1',
      subCallId: 'call-1:ptc:2',
      name: 'edit',
      arguments: { file: '/work/b.txt', edits: [{ anchor_from: 'abc', anchor_to: 'def', replace_with: 'x\n' }] },
      isError: true,
      content: [{ type: 'text', text: 'edit failed' }],
    },
  },
])

test('ptc dispatch events reach the touched index', () => {
  const { rawMessages, rendered } = collectMessages(session, 'all')
  const out = formatTouchedOutput(getTouchedFiles(rawMessages, rendered))
  assert.match(out, /\/work\/a\.txt/)
  assert.match(out, /\/work\/b\.txt/)
  assert.match(out, /#4 \(write\)/)
  assert.match(out, /#5 \(edit\)/)
})
