import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFeatureDir } from '@automaker/platform';
import * as fs from '../lib/secure-fs.js';

export interface FeatureReply {
  id: string;
  at: string;
  text: string;
  imagePaths?: string[];
}

/** Append rather than rewriting feature.json: concurrent replies must not overwrite each other. */
export async function recordFeatureReply(
  projectPath: string,
  featureId: string,
  text: string,
  imagePaths?: string[]
): Promise<FeatureReply> {
  if (!/^[\w-]+$/.test(featureId) || typeof text !== 'string' || !text.trim()) {
    throw new Error('A valid task and reply are required');
  }
  const reply: FeatureReply = {
    id: randomUUID(),
    at: new Date().toISOString(),
    text,
    ...(imagePaths?.length ? { imagePaths } : {}),
  };
  const directory = getFeatureDir(projectPath, featureId);
  await fs.mkdir(directory, { recursive: true });
  await fs.appendFile(
    path.join(directory, 'reply-history.jsonl'),
    JSON.stringify(reply) + '\n',
    'utf8'
  );
  return reply;
}

export async function readFeatureReplies(
  projectPath: string,
  featureId: string
): Promise<FeatureReply[]> {
  if (!/^[\w-]+$/.test(featureId)) throw new Error('Invalid feature ID');
  let text: string;
  try {
    text = (await fs.readFile(
      path.join(getFeatureDir(projectPath, featureId), 'reply-history.jsonl'),
      'utf8'
    )) as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as FeatureReply;
      return typeof value.id === 'string' &&
        typeof value.text === 'string' &&
        typeof value.at === 'string' &&
        Number.isFinite(Date.parse(value.at))
        ? [value]
        : [];
    } catch {
      // A partially written final line must not hide earlier replies.
      return [];
    }
  });
}
