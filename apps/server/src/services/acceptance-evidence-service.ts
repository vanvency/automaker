import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AcceptanceEvidence } from '@automaker/types';
import { getFeatureDir, validatePath } from '@automaker/platform';
import * as fs from '../lib/secure-fs.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const contained = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};

function text(value: unknown, field: string, limit = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`Invalid acceptance ${field}`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid acceptance ${field}`);
  return result;
}

function httpUrl(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const url = new URL(text(value, 'URL', 2048));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Acceptance URLs must use HTTP(S) without credentials');
  }
  if (
    [...url.searchParams.keys()].some((key) =>
      /token|password|secret|api.?key|authorization/i.test(key)
    )
  ) {
    throw new Error('Acceptance URLs must not contain credentials');
  }
  return url.toString();
}

/** Schema validation is shared by explicit import and automatic post-run collection. */
export function parseAcceptanceManifest(value: unknown): Omit<AcceptanceEvidence, 'importedAt'> {
  const m = value as Record<string, unknown>;
  if (!m || !['passed', 'failed', 'blocked'].includes(m.status as string)) {
    throw new Error('Invalid acceptance status');
  }
  if (
    !Array.isArray(m.checks) ||
    m.checks.length > 100 ||
    !Array.isArray(m.screenshots) ||
    m.screenshots.length > 20
  ) {
    throw new Error('Acceptance manifest must contain checks and screenshots arrays');
  }
  const checks: AcceptanceEvidence['checks'] = m.checks.map((check) => {
    if (!check || !['passed', 'failed', 'skipped'].includes(check.status)) {
      throw new Error('Invalid acceptance check');
    }
    return {
      name: text(check.name, 'check name', 200),
      status: check.status,
      details: check.details === undefined ? undefined : text(check.details, 'check details', 8000),
    };
  });
  const screenshots: AcceptanceEvidence['screenshots'] = m.screenshots.map((shot) => {
    if (!shot || !['prototype', 'actual'].includes(shot.kind)) {
      throw new Error('Invalid acceptance screenshot kind');
    }
    return {
      kind: shot.kind,
      path: text(shot.path, 'screenshot path', 4096),
      title: text(shot.title, 'screenshot title', 200),
      capturedAt: timestamp(shot.capturedAt, 'screenshot timestamp'),
      sourceUrl: httpUrl(shot.sourceUrl),
    };
  });
  if (
    m.status === 'passed' &&
    (!checks.some((check) => check.status === 'passed') ||
      checks.some((check) => check.status === 'failed') ||
      !screenshots.some((shot) => shot.kind === 'prototype') ||
      !screenshots.some((shot) => shot.kind === 'actual'))
  )
    throw new Error(
      'Passed acceptance requires passing checks plus prototype and actual screenshots'
    );
  return {
    status: m.status as AcceptanceEvidence['status'],
    summary: text(m.summary, 'summary', 12000),
    previewUrl: httpUrl(m.previewUrl),
    verifiedAt: timestamp(m.verifiedAt, 'verifiedAt'),
    commit: m.commit === undefined ? undefined : text(m.commit, 'commit', 200),
    checks,
    screenshots,
  };
}

function imageExtension(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
    return '.webp';
  throw new Error('Acceptance screenshots must be PNG, JPEG or WebP images');
}

/**
 * Import only the feature-scoped manifest and raster images from its worktree.
 * Copy content-addressed images to durable feature storage before publishing paths.
 * Missing/stale manifests are ignored for ordinary agent runs.
 */
export async function collectAcceptanceEvidence(
  projectPath: string,
  featureId: string,
  worktreePath: string,
  newerThan?: number
): Promise<AcceptanceEvidence | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(featureId)) throw new Error('Invalid feature ID');
  validatePath(projectPath);
  validatePath(worktreePath);
  let directory = path.join(path.resolve(worktreePath), '.automaker', 'acceptance', featureId);
  const manifestPath = path.join(directory, 'manifest.json');
  let stat;
  try {
    stat = await fs.stat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (newerThan !== undefined && stat.mtimeMs < newerThan) return null;
  directory = path.join(await realpath(worktreePath), '.automaker', 'acceptance', featureId);
  const realManifest = await realpath(manifestPath);
  if (!contained(directory, realManifest))
    throw new Error('Acceptance manifest escapes its evidence directory');
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('Acceptance manifest exceeds 128 KiB');
  const manifest = parseAcceptanceManifest(
    JSON.parse((await fs.readFile(realManifest, 'utf8')) as string)
  );
  const images = await Promise.all(
    manifest.screenshots.map(async (shot) => {
      const source = await realpath(path.resolve(directory, shot.path));
      if (!contained(directory, source))
        throw new Error('Acceptance screenshot escapes its evidence directory');
      const info = await fs.stat(source);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
        throw new Error('Acceptance screenshot exceeds 10 MiB or is not a file');
      const buffer = (await fs.readFile(source)) as Buffer;
      const ext = imageExtension(buffer);
      const hash = createHash('sha256').update(buffer).digest('hex');
      return { shot, buffer, file: `${hash}${ext}` };
    })
  );
  const destination = path.join(getFeatureDir(projectPath, featureId), 'acceptance');
  await fs.mkdir(destination, { recursive: true });
  const screenshots = await Promise.all(
    images.map(async ({ shot, buffer, file }) => {
      const target = path.join(destination, file);
      await fs.writeFile(target, buffer, { mode: 0o600 });
      return { ...shot, path: target };
    })
  );
  return { ...manifest, screenshots, importedAt: new Date().toISOString() };
}
