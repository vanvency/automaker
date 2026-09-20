import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  collectAcceptanceEvidence,
  parseAcceptanceManifest,
} from '../../../src/services/acceptance-evidence-service.js';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSuoAAAAASUVORK5CYII=',
  'base64'
);
const manifest = () => ({
  status: 'passed',
  summary: 'Export downloaded successfully',
  verifiedAt: '2026-09-19T07:00:00Z',
  previewUrl: 'http://127.0.0.1:31000',
  checks: [{ name: 'export', status: 'passed', details: 'Downloaded 2 audit rows' }],
  screenshots: ['prototype', 'actual'].map((kind) => ({
    kind,
    path: `${kind}.png`,
    title: kind,
    capturedAt: '2026-09-19T07:00:00Z',
    sourceUrl: 'http://127.0.0.1:31000/audit',
  })),
});

describe('acceptance evidence import', () => {
  let project: string;
  let worktree: string;
  let directory: string;
  beforeEach(async () => {
    project = await mkdtemp(path.join(os.tmpdir(), 'acceptance-evidence-'));
    worktree = path.join(project, 'worktree');
    directory = path.join(worktree, '.automaker', 'acceptance', 'task-1');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest()));
    await writeFile(path.join(directory, 'prototype.png'), image);
    await writeFile(path.join(directory, 'actual.png'), image);
  });
  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('preserves real evidence after the worktree is removed', async () => {
    const result = await collectAcceptanceEvidence(project, 'task-1', worktree);
    expect(result?.status).toBe('passed');
    expect(result?.screenshots.map((shot) => shot.kind)).toEqual(['prototype', 'actual']);
    await rm(worktree, { recursive: true });
    for (const shot of result!.screenshots) {
      expect(shot.path).toContain('/.automaker/features/task-1/acceptance/');
      expect(await readFile(shot.path)).toEqual(image);
    }
  });

  it('ignores missing manifests and artifacts from previous executions', async () => {
    expect(await collectAcceptanceEvidence(project, 'other-task', worktree)).toBeNull();
    await utimes(path.join(directory, 'manifest.json'), 1, 1);
    expect(await collectAcceptanceEvidence(project, 'task-1', worktree, Date.now())).toBeNull();
  });

  it('rejects screenshot symlinks outside the evidence folder', async () => {
    await writeFile(path.join(project, 'outside.png'), image);
    await rm(path.join(directory, 'actual.png'));
    await symlink(path.join(project, 'outside.png'), path.join(directory, 'actual.png'));
    await expect(collectAcceptanceEvidence(project, 'task-1', worktree)).rejects.toThrow('escapes');
  });

  it('rejects manifests redirected outside the evidence folder', async () => {
    await writeFile(path.join(project, 'outside.json'), JSON.stringify(manifest()));
    await rm(path.join(directory, 'manifest.json'));
    await symlink(path.join(project, 'outside.json'), path.join(directory, 'manifest.json'));
    await expect(collectAcceptanceEvidence(project, 'task-1', worktree)).rejects.toThrow('escapes');
  });

  it('rejects disguised HTML and SVG images before copying', async () => {
    await writeFile(path.join(directory, 'actual.png'), '<svg onload="alert(1)"></svg>');
    await expect(collectAcceptanceEvidence(project, 'task-1', worktree)).rejects.toThrow(
      'PNG, JPEG or WebP'
    );
  });

  it('does not accept a passed result without actual and prototype evidence', () => {
    expect(() => parseAcceptanceManifest({ ...manifest(), screenshots: [] })).toThrow('requires');
    expect(() =>
      parseAcceptanceManifest({
        ...manifest(),
        checks: [{ name: 'export', status: 'failed' }],
      })
    ).toThrow('requires');
  });

  it('allows incomplete evidence to report blocked honestly', () => {
    expect(
      parseAcceptanceManifest({
        ...manifest(),
        status: 'blocked',
        screenshots: [],
        checks: [],
      }).status
    ).toBe('blocked');
  });

  it.each([
    'javascript:alert(1)',
    'http://user:secret@preview.test',
    'http://preview.test?token=secret',
  ])('rejects unsafe or credential-bearing source URLs: %s', (previewUrl) =>
    expect(() => parseAcceptanceManifest({ ...manifest(), previewUrl })).toThrow()
  );

  it('rejects traversal in feature IDs', async () => {
    await expect(collectAcceptanceEvidence(project, '../outside', worktree)).rejects.toThrow(
      'feature ID'
    );
  });
});
