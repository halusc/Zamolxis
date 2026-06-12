import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';

/**
 * Host application scanner: discovers the REAL apps installed on the machine (per OS) so the
 * desktop can show them as launchers that open the actual programs.
 *  - Windows: Start-Menu .lnk shortcuts (all-users + per-user), resolved via WScript.Shell.
 *  - macOS:   .app bundles in /Applications, /System/Applications, ~/Applications.
 *  - Linux:   .desktop entries in the standard application dirs.
 * Results cache to <dataDir>/apps.json; icons extract lazily to <dataDir>/appicons/<id>.png.
 */

export interface HostApp { id: string; name: string; launch: string; target?: string; os: string; cat?: string }

let APPS: HostApp[] = [];
let cacheFile = '';
let iconDir = '';

function idOf(s: string): string { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }

const WIN_SCAN_PS = `
$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
$sh = New-Object -ComObject WScript.Shell
$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
$seen = @{}
$out = @()
foreach($base in $dirs){
  Get-ChildItem -Path $base -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk=$_.FullName; $name=$_.BaseName
    if($name -match 'uninstall|read ?me|readme|website|web site|home ?page|documentation|^help$|license|change ?log|release notes|^visit |on the web|report a (bug|problem)'){ return }
    try { $t=$sh.CreateShortcut($lnk).TargetPath } catch { $t='' }
    if(-not $t){ return }
    if($t -match '\\.(url|chm|txt|html?|pdf|ico)$'){ return }
    if(-not (Test-Path $t)){ return }
    $key=$name.ToLower()
    if($seen.ContainsKey($key)){ return }
    $seen[$key]=$true
    $out += [pscustomobject]@{ name=$name; lnk=$lnk; target=$t }
  }
}
Write-Output (ConvertTo-Json @($out) -Depth 3 -Compress)
`;

function scanWindows(): HostApp[] {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_SCAN_PS, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const arr = JSON.parse((r.stdout || '[]').trim() || '[]') as Array<{ name: string; lnk: string; target: string }>;
    const list = Array.isArray(arr) ? arr : [arr];
    return list.filter((a) => a && a.name).map((a) => ({ id: idOf(a.lnk), name: a.name, launch: a.lnk, target: a.target, os: 'win', cat: 'Apps' }));
  } catch (err) {
    logger.warn({ err: String(err) }, 'windows app scan failed');
    return [];
  }
}

function scanMac(): HostApp[] {
  const out: HostApp[] = [];
  const roots = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.app')) { const name = e.name.replace(/\.app$/, ''); if (!seen.has(name)) { seen.add(name); out.push({ id: idOf(full), name, launch: full, os: 'mac', cat: 'Apps' }); } }
      else if (e.isDirectory() && depth < 2 && !e.name.endsWith('.app')) walk(full, depth + 1);
    }
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

function scanLinux(): HostApp[] {
  const out: HostApp[] = [];
  const dirs = ['/usr/share/applications', '/usr/local/share/applications', path.join(os.homedir(), '.local/share/applications'), '/var/lib/flatpak/exports/share/applications', path.join(os.homedir(), '.local/share/flatpak/exports/share/applications')];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      try {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        if (/^NoDisplay\s*=\s*true/im.test(txt) || /^Type\s*=\s*(?!Application)/im.test(txt)) continue;
        const name = (/^Name\s*=\s*(.+)$/im.exec(txt) || [])[1]?.trim();
        const exec = (/^Exec\s*=\s*(.+)$/im.exec(txt) || [])[1]?.trim().replace(/%[a-zA-Z]/g, '').trim();
        const icon = (/^Icon\s*=\s*(.+)$/im.exec(txt) || [])[1]?.trim();
        if (!name || !exec || seen.has(name)) continue;
        seen.add(name);
        out.push({ id: idOf(f), name, launch: exec, target: icon, os: 'linux', cat: 'Apps' });
      } catch { /* skip */ }
    }
  }
  return out;
}

/** Run a fresh scan (synchronous-ish) and cache it. */
export function rescanApps(): HostApp[] {
  const list = process.platform === 'win32' ? scanWindows() : process.platform === 'darwin' ? scanMac() : scanLinux();
  list.sort((a, b) => a.name.localeCompare(b.name));
  APPS = list;
  try { if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(list)); } catch { /* */ }
  logger.info({ count: list.length, os: process.platform }, 'host apps scanned');
  return list;
}

export function listApps(): HostApp[] { return APPS; }
export function appById(id: string): HostApp | undefined { return APPS.find((a) => a.id === id); }

/** Launch the real app. */
export function launchHostApp(id: string): { ok: boolean; error?: string; name?: string } {
  const a = appById(id);
  if (!a) return { ok: false, error: 'unknown app' };
  try {
    if (a.os === 'win') spawn('cmd', ['/c', 'start', '', a.launch], { detached: true, windowsHide: true }).unref();
    else if (a.os === 'mac') spawn('open', ['-a', a.launch], { detached: true }).unref();
    else spawn('sh', ['-c', a.launch + ' >/dev/null 2>&1 &'], { detached: true }).unref();
    return { ok: true, name: a.name };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const ICON_PS = `
$ErrorActionPreference='SilentlyContinue'
try { Add-Type -AssemblyName System.Drawing
  $ico=[System.Drawing.Icon]::ExtractAssociatedIcon($env:ZXICO_SRC)
  if($ico){ $bmp=$ico.ToBitmap(); $bmp.Save($env:ZXICO_OUT,[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $ico.Dispose() }
} catch {}
`;

/** Return a PNG icon path for an app (extract + cache), or null if unavailable. */
export function appIconPng(id: string): string | null {
  const a = appById(id);
  if (!a || !iconDir) return null;
  const out = path.join(iconDir, id + '.png');
  try { if (fs.existsSync(out) && fs.statSync(out).size > 0) return out; } catch { /* */ }
  try {
    if (a.os === 'win') {
      const src = a.target || a.launch;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ICON_PS, 'utf16le').toString('base64')], { env: { ...process.env, ZXICO_SRC: src, ZXICO_OUT: out }, windowsHide: true, timeout: 8000 });
      void r;
    } else if (a.os === 'mac') {
      // find the .icns in the bundle and convert to png via sips
      const res = path.join(a.launch, 'Contents', 'Resources');
      let icns = '';
      try { icns = fs.readdirSync(res).filter((f) => f.endsWith('.icns'))[0] || ''; } catch { /* */ }
      if (icns) spawnSync('sips', ['-s', 'format', 'png', '-Z', '64', path.join(res, icns), '--out', out], { timeout: 8000 });
    } else if (a.os === 'linux' && a.target) {
      // icon may be an absolute path or a theme name
      if (a.target.startsWith('/') && fs.existsSync(a.target)) return a.target;
      for (const base of ['/usr/share/icons/hicolor/64x64/apps', '/usr/share/icons/hicolor/48x48/apps', '/usr/share/pixmaps']) {
        for (const ext of ['.png', '.svg']) { const p = path.join(base, a.target + ext); if (fs.existsSync(p)) return p; }
      }
    }
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  } catch { /* */ }
  return null;
}

/** Init at startup: load cache, scan in the background if empty/stale. */
export function initAppScan(dataDir: string): void {
  cacheFile = path.join(dataDir, 'apps.json');
  iconDir = path.join(dataDir, 'appicons');
  try { fs.mkdirSync(iconDir, { recursive: true }); } catch { /* */ }
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (Array.isArray(c) && c.length) APPS = c; } catch { /* no cache */ }
  // Always refresh in the background (installs change); a slow scan won't block startup.
  setTimeout(() => { try { rescanApps(); } catch { /* */ } }, APPS.length ? 5000 : 200);
}
