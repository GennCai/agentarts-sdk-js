/**
 * Unit tests for the runtime stop-session operation.
 *
 * Ported 1:1 from `tests/unit/toolkit/operations/runtime/test_stop_session.py`.
 *
 * Mock strategy:
 * - `unittest.mock.patch("…stop_session._get_data_endpoint")` →
 *   `vi.mock` of the shared `invoke` module with `_getDataEndpoint` replaced
 *   (the port resolves `_resolveAgentInfo` from `.agentarts_config.yaml`, so it
 *   is left real, exactly like the Python tests that do not patch it);
 * - `unittest.mock.patch("…stop_session.RuntimeClient")` → `vi.mock` of the SDK
 *   module with the class replaced by a `vi.fn()` returning a mock client;
 * - `monkeypatch.chdir(tmp_path)` → `process.cwd()` stubbed to a `mkdtemp()`
 *   directory (the operations look the config file up relative to cwd).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopRuntimeSession } from 'agentarts-sdk/toolkit/operations/runtime/stop-session';

const invokeMocks = vi.hoisted(() => ({ getDataEndpoint: vi.fn() }));

vi.mock('agentarts-sdk/toolkit/operations/runtime/invoke', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('agentarts-sdk/toolkit/operations/runtime/invoke')>();
  return { ...actual, _getDataEndpoint: invokeMocks.getDataEndpoint };
});

const clientMocks = vi.hoisted(() => ({ RuntimeClient: vi.fn() }));

vi.mock('agentarts-sdk/sdk/service/runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentarts-sdk/sdk/service/runtime-client')>();
  return {
    ...actual,
    RuntimeClient: clientMocks.RuntimeClient as unknown as typeof actual.RuntimeClient,
  };
});

/** Mock runtime client returned by the `RuntimeClient` constructor. */
interface MockRuntimeClient {
  setAuthToken: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
}

let tmpDir: string;
let client: MockRuntimeClient;

const CONFIG = `
default_agent: test-agent
agents:
  test-agent:
    base:
      name: test-agent
      region: cn-north-4
`;

const TWO_AGENTS_CONFIG = `
default_agent: default-agent
agents:
  default-agent:
    base:
      name: default-agent
      region: cn-north-4
  custom-agent:
    base:
      name: custom-agent
      region: cn-north-7
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentarts-stop-session-'));
  // Python `monkeypatch.chdir(tmp_path)`: the operations resolve the config file
  // through `process.cwd()`, which is stubbed instead of changing the real
  // working directory (the vitest threads pool shares one process).
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  client = {
    setAuthToken: vi.fn(),
    stopSession: vi.fn().mockResolvedValue({ status: 'stopped' }),
  };
  clientMocks.RuntimeClient.mockImplementation(function () {
    return client;
  });
  invokeMocks.getDataEndpoint.mockResolvedValue('https://test.example.com');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('stopRuntimeSession', () => {
  it('raises when no agent can be resolved', async () => {
    await expect(stopRuntimeSession({ sessionId: 'session-123' })).rejects.toThrow(
      'Agent name is required',
    );
  });

  it('raises when no session id is given', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await expect(stopRuntimeSession()).rejects.toThrow('Session ID is required');
  });

  it('stops the session through the runtime client', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    const result = await stopRuntimeSession({ sessionId: 'session-123' });

    expect(result['status']).toBe('stopped');
    expect(client.stopSession).toHaveBeenCalledTimes(1);
    const [agentName, sessionId, options] = client.stopSession.mock.calls[0]!;
    expect(agentName).toBe('test-agent');
    expect(sessionId).toBe('session-123');
    expect(options).toEqual({ bearerToken: null, endpoint: null, userId: null });
  });

  it('uses the explicitly requested agent', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), TWO_AGENTS_CONFIG);

    await stopRuntimeSession({ agentName: 'custom-agent', sessionId: 'session-123' });

    expect(client.stopSession.mock.calls[0]![0]).toBe('custom-agent');
  });

  it('passes the region to the runtime client', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await stopRuntimeSession({ sessionId: 'session-123', region: 'cn-north-7' });

    expect(clientMocks.RuntimeClient).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: 'cn-north-7' }),
    );
  });

  it('raises when the agent has no data endpoint', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    invokeMocks.getDataEndpoint.mockResolvedValue(null);

    await expect(stopRuntimeSession({ sessionId: 'session-123' })).rejects.toThrow(
      'No data endpoint',
    );
  });
});
