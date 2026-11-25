import { expect, it, vi } from 'vitest';
import { GlobalAutoModeService } from '../../../src/services/auto-mode/global-service.js';

vi.mock('../../../src/lib/secure-fs.js', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@automaker/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@automaker/platform')>()),
  ensureAutomakerDir: vi.fn().mockResolvedValue(undefined),
}));

it('detaches tracked Herdr turns while preserving local provider interruption and the restart snapshot', async () => {
  const herdr = {
    projectPath: '/project',
    featureId: 'pi',
    abortController: new AbortController(),
  };
  const local = {
    projectPath: '/project',
    featureId: 'local',
    abortController: new AbortController(),
  };
  const mark = vi.fn();
  const service = {
    concurrencyManager: { getAllRunning: () => [herdr, local] },
    featureStateManager: {
      loadFeature: vi.fn(async (_project, id) =>
        id === 'pi' ? { herdrExecution: { paneId: 'p1' } } : {}
      ),
      markFeatureInterrupted: mark,
    },
  };
  await GlobalAutoModeService.prototype.prepareForShutdown.call(
    service as unknown as GlobalAutoModeService,
    'restart'
  );
  expect(mark).toHaveBeenCalledExactlyOnceWith('/project', 'local', 'restart');
  expect(herdr.abortController.signal.aborted).toBe(true); // Stops only the observer.
  expect(local.abortController.signal.aborted).toBe(true);
  const fs = await import('../../../src/lib/secure-fs.js');
  expect(JSON.parse(vi.mocked(fs.writeFile).mock.calls[0][1] as string).runningFeatureIds).toEqual([
    'pi',
    'local',
  ]);
});
