import { it, expect } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  recordFeatureReply,
  readFeatureReplies,
} from '../../../src/services/feature-reply-history.js';

it('retains concurrent, repeated replies and attachments independently of execution output', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'reply-history-'));
  try {
    const replies = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordFeatureReply(project, 'task', 'Same reply\nFull text', ['/evidence/a.png'])
      )
    );
    const saved = await readFeatureReplies(project, 'task');
    expect(saved).toHaveLength(12);
    expect(new Set(saved.map((reply) => reply.id)).size).toBe(12);
    expect(saved).toEqual(expect.arrayContaining(replies));
    await appendFile(
      path.join(project, '.automaker/features/task/reply-history.jsonl'),
      '{"partial":'
    );
    expect(await readFeatureReplies(project, 'task')).toHaveLength(12);
    expect(await readFeatureReplies(project, 'other-task')).toEqual([]);
    await expect(recordFeatureReply(project, '../outside', 'reply')).rejects.toThrow('valid task');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
