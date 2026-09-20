#!/usr/bin/env node
/**
 * Capture prototype (vibe-design, port 3001) screenshots for feature parity review.
 *
 * Usage:
 *   node scripts/parity-shot.mjs --out <dir> [--base http://127.0.0.1:3001] <route> [...]
 *
 * Writes <out>/<index>-<slug>.png and prints a JSON array of the captured files.
 * Prototype pages are mock driven, so no login or fixture setup is required.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const baseIndex = args.indexOf('--base');
const out = outIndex >= 0 ? args[outIndex + 1] : null;
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'http://127.0.0.1:3001';

const consumed = new Set();
if (outIndex >= 0) {
  consumed.add(outIndex);
  consumed.add(outIndex + 1);
}
if (baseIndex >= 0) {
  consumed.add(baseIndex);
  consumed.add(baseIndex + 1);
}
const routes = args.filter((_, i) => !consumed.has(i));

if (!out || routes.length === 0) {
  console.error('usage: node scripts/parity-shot.mjs --out <dir> [--base url] <route> [...]');
  process.exit(2);
}

const { chromium } = await import('playwright');

/** Locate a cached chromium build; the cache may be newer than the local playwright. */
function cachedChromium() {
  const root = path.join(process.env.HOME || '/root', '.cache/ms-playwright');
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse();
  for (const build of builds) {
    const candidate = path.join(root, build, 'chrome-linux64', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

mkdirSync(out, { recursive: true });

const slug = (route) =>
  route
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120) || 'root';

const browser = await chromium.launch({ executablePath: cachedChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const captured = [];
let index = 0;
for (const route of routes) {
  const url = base.replace(/\/$/, '') + (route.startsWith('/') ? route : '/' + route);
  const file = path.join(out, `${String(index).padStart(2, '0')}-${slug(route)}.png`);
  const record = { route, url, file, ok: false };
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: file, fullPage: true });
    const body = (await page.innerText('body')) || '';
    writeFileSync(`${file}.txt`, body, 'utf8');
    if (/Unexpected Application Error|404 Not Found/.test(body)) {
      record.error = '页面渲染为错误页（路由不存在）';
    } else {
      record.ok = true;
    }
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  captured.push(record);
  index += 1;
}
await browser.close();

console.log(JSON.stringify(captured, null, 2));
