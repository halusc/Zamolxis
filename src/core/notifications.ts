/** In-memory notification feed pushed to the desktop (toasts / browser notifications). */
export interface Notif { id: number; ts: number; title: string; body: string; kind?: string }
let seq = 0;
const ring: Notif[] = [];

export function pushNotif(title: string, body: string, kind?: string): Notif {
  const n: Notif = { id: ++seq, ts: Date.now(), title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 500), kind };
  ring.push(n);
  if (ring.length > 100) ring.splice(0, ring.length - 100);
  return n;
}
export function notifsSince(since: number): Notif[] {
  return ring.filter((n) => n.id > since);
}
export function latestNotifId(): number { return seq; }
