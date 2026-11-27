// Keeps one window (one debugging target) showing the current plan. Idempotent and cheap when
// nothing changed: one short question per poll, and the stylesheet itself only when it is stale.
import { CdpSession } from './cdp.mjs';

// `sessions` maps a target id to { session, registered, key, last }; it belongs to the caller so
// the same connection is reused across polls. Returns what the window reported, or null when the
// window already shows the plan.
export async function syncTarget(target, sessions, plan, { log = () => {} } = {}) {
  let entry = sessions.get(target.id);
  if (!entry || entry.session.closed) {
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    entry = { session, registered: null, key: null, last: null };
    sessions.set(target.id, entry);
    await session.send('Page.enable');
  }
  const { session } = entry;
  if (entry.key !== plan.key) {
    // Register first, so a reload in the middle of this starts with the new stylesheet rather
    // than the old one, then bring the document that is already loaded up to date.
    if (entry.registered !== null) {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.registered }).catch(() => {});
    }
    const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', { source: plan.script });
    entry.registered = identifier;
    entry.key = plan.key;
  }
  if ((await session.evaluate(plan.check)) === 'ok') return null;
  const result = await session.evaluate(plan.script);
  if (result !== entry.last) log(`${target.title || target.url}: ${result}`);
  entry.last = result;
  return result;
}

export function closeAll(sessions) {
  for (const entry of sessions.values()) entry.session.close();
  sessions.clear();
}
