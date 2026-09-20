import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPiWebTarget,
  resolvePiWebBaseUrl,
} from '../../../../src/routes/features/routes/pi-web.js';

describe('features/pi-web target resolution', () => {
  beforeEach(() => {
    delete process.env.PI_WEB_URL;
  });

  it('defaults to the standalone Pi Web server', () => {
    expect(resolvePiWebBaseUrl({})).toBe('http://127.0.0.1:30141');
  });

  it('honours PI_WEB_URL and strips trailing slashes', () => {
    expect(resolvePiWebBaseUrl({ PI_WEB_URL: 'http://10.0.0.5:8080//' })).toBe(
      'http://10.0.0.5:8080'
    );
  });

  it('deep-links to the pi-web session when it is running', () => {
    const target = buildPiWebTarget({
      backend: 'pi-web',
      sessionId: '01a0a41d-16ff-72e8-a2bf-531440ae651d',
      workDir: '/workspace/automaker',
      projectPath: '/workspace/automaker',
      title: 'Some feature',
      model: { provider: 'litellm', modelId: 'deepseek-flash' },
      protocol: 'http',
      host: '127.0.0.1:3008',
      piWebUrl: 'http://127.0.0.1:30141',
    });

    expect(target.url).toBe('http://127.0.0.1:30141/?session=01a0a41d-16ff-72e8-a2bf-531440ae651d');
    expect(target.path).toBeUndefined();
  });

  it('rewrites the browser-facing host for remote setups', () => {
    const target = buildPiWebTarget({
      backend: 'pi-web',
      sessionId: 'abc',
      workDir: '/w',
      projectPath: '/w',
      title: 't',
      protocol: 'http',
      host: '127.0.0.1:3008',
      piWebUrl: 'http://127.0.0.1:30141',
      piWebHost: 'automaker.lan:30141',
    });

    expect(target.url).toBe('http://automaker.lan:30141/?session=abc');
  });

  it('falls back to the built-in viewer when pi-web is unavailable', () => {
    const target = buildPiWebTarget({
      backend: 'builtin',
      sessionId: 'abc',
      workDir: '/workspace/automaker',
      projectPath: '/workspace/automaker',
      title: 'Some feature',
      model: { provider: 'litellm', modelId: 'auto' },
      protocol: 'http',
      host: '127.0.0.1:3008',
      piWebUrl: 'http://127.0.0.1:30141',
    });

    expect(target.url).toContain('http://127.0.0.1:3008/api/pi-web/view?');
    expect(target.path).toContain('/api/pi-web/view?');
    expect(target.path).toContain('sessionId=abc');
    expect(target.path).toContain('model=litellm%2Fauto');
  });
});
