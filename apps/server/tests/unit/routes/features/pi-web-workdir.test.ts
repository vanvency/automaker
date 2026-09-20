import { describe, it, expect, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  createSendHandler,
  createSessionHandler,
  disallowedWorkDirError,
} from '../../../../src/routes/pi-web/index.js';

/**
 * The Pi agent runs with write/bash tools in `workDir`, so the route must reject
 * a directory outside ALLOWED_ROOT_DIRECTORY the same way every other execution
 * route does.
 */
function restrictedTo(root: string): () => void {
  const original = process.env.ALLOWED_ROOT_DIRECTORY;
  process.env.ALLOWED_ROOT_DIRECTORY = root;
  return () => {
    if (original === undefined) {
      delete process.env.ALLOWED_ROOT_DIRECTORY;
    } else {
      process.env.ALLOWED_ROOT_DIRECTORY = original;
    }
  };
}

async function reinitAllowedPaths(): Promise<void> {
  const { initAllowedPaths } = await import('@automaker/platform');
  initAllowedPaths();
}

interface RecordedResponse {
  statusCode: number | null;
  body: unknown;
  res: Response;
}

function fakeResponse(): RecordedResponse {
  const recorded: RecordedResponse = {
    statusCode: null,
    body: null,
    res: null as unknown as Response,
  };
  recorded.res = {
    status(code: number) {
      recorded.statusCode = code;
      return this;
    },
    json(body: unknown) {
      recorded.body = body;
      return this;
    },
  } as unknown as Response;
  return recorded;
}

afterEach(async () => {
  delete process.env.ALLOWED_ROOT_DIRECTORY;
  await reinitAllowedPaths();
});

describe('pi-web workDir validation', () => {
  it('allows directories inside ALLOWED_ROOT_DIRECTORY', async () => {
    const restore = restrictedTo('/workspace');
    await reinitAllowedPaths();
    try {
      expect(disallowedWorkDirError('/workspace/automaker/.worktrees/x')).toBeNull();
    } finally {
      restore();
    }
  });

  it('rejects directories outside ALLOWED_ROOT_DIRECTORY', async () => {
    const restore = restrictedTo('/workspace');
    await reinitAllowedPaths();
    try {
      expect(disallowedWorkDirError('/etc')).toContain('not allowed');
    } finally {
      restore();
    }
  });

  it('rejects a disallowed workDir before spawning the agent', async () => {
    const restore = restrictedTo('/workspace');
    await reinitAllowedPaths();
    try {
      const recorded = fakeResponse();
      const handler = createSendHandler();
      await handler(
        { body: { workDir: '/etc', message: 'do something' } } as unknown as Request,
        recorded.res
      );

      expect(recorded.statusCode).toBe(400);
      expect(recorded.body).toMatchObject({ success: false });
    } finally {
      restore();
    }
  });

  it('rejects a disallowed workDir when reading a session', async () => {
    const restore = restrictedTo('/workspace');
    await reinitAllowedPaths();
    try {
      const recorded = fakeResponse();
      const handler = createSessionHandler();
      await handler({ query: { workDir: '/etc' } } as unknown as Request, recorded.res);

      expect(recorded.statusCode).toBe(400);
      expect(recorded.body).toMatchObject({ success: false });
    } finally {
      restore();
    }
  });
});
