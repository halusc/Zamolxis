import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { pushNotif } from './notifications.js';
import { outlookMailData } from './outlookLocal.js';

/**
 * Proactive watchers (OpenClaw-style): background checks that run on an interval and push a
 * notification when something NEW happens — without the user asking. v1 ships an Outlook
 * unread-inbox watcher. Config persists in <dataDir>/watchers.json; each watcher baselines
 * on first run (and on restart) so it never alerts on the existing backlog.
 */

interface OutlookWatch { enabled: boolean; intervalMin: number }
interface WatchConfig { outlookUnread?: OutlookWatch }

let cfgFile = '';
let timer: NodeJS.Timeout | null = null;
let seen = new Set<string>();
let primed = false;

function readCfg(): WatchConfig {
  try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as WatchConfig; } catch { return {}; }
}
export function getWatchers(): { outlookUnread: OutlookWatch } {
  const c = readCfg();
  return { outlookUnread: c.outlookUnread || { enabled: false, intervalMin: 5 } };
}
export function setWatchers(patch: WatchConfig): { outlookUnread: OutlookWatch } {
  const c = readCfg();
  if (patch.outlookUnread) c.outlookUnread = { enabled: !!patch.outlookUnread.enabled, intervalMin: Math.max(1, Math.min(120, Math.round(patch.outlookUnread.intervalMin || 5))) };
  try { fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2)); } catch (e) { logger.warn({ err: String(e) }, 'watchers config write failed'); }
  primed = false; // re-baseline on config change so we don't alert the backlog
  schedule();
  return getWatchers();
}

async function runOutlook(): Promise<void> {
  try {
    const d = await outlookMailData({ action: 'list', unreadOnly: true, count: 25 });
    const msgs = (d.messages as Array<{ id: string; from: string; subject: string }> | undefined) || [];
    if (!primed) { msgs.forEach((m) => seen.add(m.id)); primed = true; return; } // baseline, no alerts
    const fresh = msgs.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.add(m.id));
    fresh.reverse().forEach((m) => pushNotif('📧 ' + (m.from || 'New email'), m.subject || '(no subject)', 'mail'));
    if (fresh.length) logger.info({ count: fresh.length }, 'outlook watcher: new unread mail');
  } catch (err) {
    logger.warn({ err: String(err) }, 'outlook watcher check failed');
  }
}

function schedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
  const w = getWatchers().outlookUnread;
  if (!w.enabled) return;
  void runOutlook(); // prime immediately (baselines current unread)
  timer = setInterval(() => void runOutlook(), Math.max(1, w.intervalMin) * 60_000);
  timer.unref?.();
  logger.info({ everyMin: w.intervalMin }, 'outlook inbox watcher started');
}

export function initWatchers(dataDir: string): void {
  cfgFile = path.join(dataDir, 'watchers.json');
  schedule();
}
