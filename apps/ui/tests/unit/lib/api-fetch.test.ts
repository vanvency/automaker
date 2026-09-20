import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withPageAuthParams } from '../../../src/lib/api-fetch';

const mockAuth = {
  apiKey: null as string | null,
  sessionToken: null as string | null,
};

vi.mock('../../../src/lib/http-api-client', () => ({
  getApiKey: () => mockAuth.apiKey,
  getSessionToken: () => mockAuth.sessionToken,
  getServerUrlSync: () => 'http://localhost:3008',
}));

describe('withPageAuthParams', () => {
  beforeEach(() => {
    mockAuth.apiKey = null;
    mockAuth.sessionToken = null;
  });

  it('carries the web-mode session token, which is how a new tab authenticates', () => {
    mockAuth.sessionToken = 'session-token-1';

    const url = withPageAuthParams(
      new URL('/api/herdr/view?session=term-1', 'http://localhost:3008')
    );

    expect(url.searchParams.get('token')).toBe('session-token-1');
    expect(url.searchParams.get('session')).toBe('term-1');
    expect(url.searchParams.has('apiKey')).toBe(false);
  });

  it('carries the Electron API key', () => {
    mockAuth.apiKey = 'api-key-1';

    const url = withPageAuthParams(
      new URL('/api/herdr/view?session=term-1', 'http://localhost:3008')
    );

    expect(url.searchParams.get('apiKey')).toBe('api-key-1');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('carries both credentials when the client has them', () => {
    mockAuth.apiKey = 'api-key-1';
    mockAuth.sessionToken = 'session-token-1';

    const url = withPageAuthParams(
      new URL('/api/herdr/view?session=term-1', 'http://localhost:3008')
    );

    expect(url.searchParams.get('apiKey')).toBe('api-key-1');
    expect(url.searchParams.get('token')).toBe('session-token-1');
  });

  it('leaves the URL untouched when the client has no credentials', () => {
    const url = withPageAuthParams(
      new URL('/api/herdr/view?session=term-1', 'http://localhost:3008')
    );

    expect(url.search).toBe('?session=term-1');
  });
});
