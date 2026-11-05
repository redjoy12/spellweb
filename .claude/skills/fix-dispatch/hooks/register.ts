import type { Register } from 'claude-code'
import { jsonOf, poll, type Port, type Session } from './dispatch.ts'

// The fix-dispatch mod: each Claude session of this project polls the deck builder API, and the
// one with the lease sends each queued "Fix this reason" brief to the session with its title.
// It costs no tokens: the poll is HTTP, and the session tools are the desktop app's own.

const POLL_MS = 20_000
const SERVER = 'ccd_session_mgmt'
const LIST = 'mcp__ccd_session_mgmt__list_sessions'
const GET = 'mcp__ccd_session_mgmt__get_session'
const SEND = 'mcp__ccd_session_mgmt__send_message'

const mine = ($: { plugin: { name: string } }, next: { origin: { plugin: string } }) => next.origin.plugin === $.plugin.name

export const register: Register = on => {
  // Allow the three session tools for this mod's own calls only; the model's calls ask as before.
  on('tool.check', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, ($, e, next) => mine($, next) ? { decision: 'allow' } : next(e))
  on('tool.check', { tool: 'mcp__ccd_session_mgmt__get_session' }, ($, e, next) => mine($, next) ? { decision: 'allow' } : next(e))
  on('tool.check', { tool: 'mcp__ccd_session_mgmt__send_message' }, ($, e, next) => mine($, next) ? { decision: 'allow' } : next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The session tools are in sessions that the desktop app hosts; elsewhere there is nothing to do.
    const names = new Set((await $.tool.list()).map(t => t.name))
    if (!names.has(LIST) || !names.has(SEND)) return started

    // The desktop app's session server, called directly (no permission prompt); the tool call is the fallback.
    const call = async (tool: string, input: Record<string, unknown>): Promise<string> => {
      let viaMcp = ''
      try {
        const r = await $.mcp.call(SERVER, tool.slice(`mcp__${SERVER}__`.length), input)
        const text = (r.content ?? []).map(c => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('')
        if (!r.isError) return text
        viaMcp = text || `${tool} failed`
      } catch (err) {
        viaMcp = (err as Error)?.message ?? String(err)
      }
      try {
        const r = await $.tool.call({ tool, ...input } as never)
        if (r.deny !== undefined) throw new Error(r.deny)
        if (r.isError) throw new Error(r.text ?? `${tool} failed`)
        return r.text ?? ''
      } catch (err) {
        throw new Error(`MCP call: ${viaMcp}; tool call: ${(err as Error)?.message ?? String(err)}`)
      }
    }
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      async sessions() {
        const self = jsonOf<Session>(await call(GET, { session_id: 'self' }))
        // A large list is more than a tool result can carry (180 rows were 64 KB), so read the open
        // sessions and the recent archived ones in two short calls.
        const open = jsonOf<Session[]>(await call(LIST, { limit: 60 }))
        const archived = jsonOf<Session[]>(await call(LIST, { include_archived: true, limit: 60 })).filter(s => s.isArchived)
        return [{ ...self, self: true }, ...open, ...archived]
      },
      send: (sessionId, message) => call(SEND, { session_id: sessionId, message }),
      async submit(text) { await $.prompt.submit({ text }) },
    }

    const me = `${await $.session.id()}:${Math.random().toString(36).slice(2, 8)}`
    let holds = false
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const r = await poll(port, me, holds)
        holds = r.holds
        for (const line of r.log) $.ui.log(`fix-dispatch: ${line}`)
      } catch {
        // The API is down (the dev server is not running): try again at the next poll.
        holds = false
      } finally {
        busy = false
      }
    }
    $.clock.after(3_000, () => void tick())
    $.clock.every(POLL_MS, () => void tick())
    return started
  })
}
