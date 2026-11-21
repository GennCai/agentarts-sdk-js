/**
 * Unit tests for the runtime start-session operation and its CLI command.
 *
 * Ported 1:1 from `tests/unit/toolkit/operations/runtime/test_start_session.py`
 * (which also covers `RuntimeClient.start_session` and
 * `toolkit/cli/runtime/start_session.py`).
 *
 * Mock strategy:
 * - `patch("…start_session._resolve_agent_info")` / `_get_data_endpoint` →
 *   `vi.mock` of the shared `invoke` module with both helpers replaced;
 * - `patch("…start_session.RuntimeClient")` → `vi.mock` of the SDK module with
 *   the class replaced by a `vi.fn()` returning a mock client;
 * - `patch("cli.runtime.start_session.start_runtime_session")` → `vi.mock` of the
 *   operations module with a pass-through `vi.fn()` (the operation tests call it
 *   through to the real implementation, the CLI tests stub its result);
 * - `CliRunner` output capture → spying on the toolkit `console.print` /
 *   `console.printPanel`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { startRuntimeSession } from 'agentarts-sdk/toolkit/operations/runtime/start-session';
import { startSessionCmd } from 'agentarts-sdk/toolkit/cli/runtime/start-session';
import { createRuntimeAppCommand } from 'agentarts-sdk/toolkit/cli/runtime/commands';
import { console as toolkitConsole } from 'agentarts-sdk/toolkit/utils/console';
import { RequestResult } from 'agentarts-sdk/sdk/service/http-client';

const invokeMocks = vi.hoisted(() => ({
  resolveAgentInfo: vi.fn(),
  getDataEndpoint: vi.fn(),
}));

vi.mock('agentarts-sdk/toolkit/operations/runtime/invoke', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('agentarts-sdk/toolkit/operations/runtime/invoke')>();
  return {
    ...actual,
    _resolveAgentInfo: invokeMocks.resolveAgentInfo,
    _getDataEndpoint: invokeMocks.getDataEndpoint,
  };
});

const clientMocks = vi.hoisted(() => ({ RuntimeClient: vi.fn() }));

vi.mock('agentarts-sdk/sdk/service/runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentarts-sdk/sdk/service/runtime-client')>();
  return {
    ...actual,
    RuntimeClient: clientMocks.RuntimeClient as unknown as typeof actual.RuntimeClient,
  };
});

/** Pass-through spy around the operation, so the CLI tests can stub it. */
const operationMocks = vi.hoisted(() => ({
  real: undefined as unknown as (...args: any[]) => Promise<Record<string, any>>,
  fn: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('agentarts-sdk/toolkit/operations/runtime/start-session', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('agentarts-sdk/toolkit/operations/runtime/start-session')>();
  operationMocks.real = actual.startRuntimeSession as (
    ...args: any[]
  ) => Promise<Record<string, any>>;
  operationMocks.fn = vi.fn((...args: any[]) => operationMocks.real(...args));
  return {
    ...actual,
    startRuntimeSession: operationMocks.fn as unknown as typeof actual.startRuntimeSession,
  };
});

/** Mock runtime client returned by the mocked `RuntimeClient` constructor. */
interface MockRuntimeClient {
  setAuthToken: ReturnType<typeof vi.fn>;
  startSession: ReturnType<typeof vi.fn>;
}

const MOCK_RESPONSE = { data: { session_id: 'session-123' } };

let client: MockRuntimeClient;

beforeEach(() => {
  // `restoreMocks` clears the implementation between tests: re-install the
  // pass-through so the operation tests exercise the real implementation.
  operationMocks.fn.mockImplementation((...args: any[]) => operationMocks.real(...args));

  client = {
    setAuthToken: vi.fn(),
    startSession: vi.fn().mockResolvedValue(MOCK_RESPONSE),
  };
  clientMocks.RuntimeClient.mockImplementation(function () {
    return client;
  });

  invokeMocks.resolveAgentInfo.mockReturnValue(['myagent', 'cn-southwest-2', 'agent-id', 'IAM']);
  invokeMocks.getDataEndpoint.mockResolvedValue('https://data.example.com');
});

describe('startRuntimeSession', () => {
  it('calls RuntimeClient.startSession', async () => {
    const result = await startRuntimeSession({ agentName: 'myagent' });

    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(client.startSession).toHaveBeenCalledWith('myagent', {
      bearerToken: null,
      endpoint: null,
      userId: null,
    });
    expect(result).toEqual(MOCK_RESPONSE);
  });

  it('passes the bearer token through', async () => {
    await startRuntimeSession({ agentName: 'myagent', bearerToken: 'test-token' });

    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(client.startSession).toHaveBeenCalledWith('myagent', {
      bearerToken: 'test-token',
      endpoint: null,
      userId: null,
    });
  });

  it('raises when no agent can be resolved', async () => {
    invokeMocks.resolveAgentInfo.mockReturnValue([null, null, null, null]);

    await expect(startRuntimeSession()).rejects.toThrow('Agent name is required');
  });

  it('raises when the agent has no data endpoint', async () => {
    invokeMocks.getDataEndpoint.mockResolvedValue(null);

    await expect(startRuntimeSession({ agentName: 'myagent' })).rejects.toThrow('No data endpoint');
  });
});

describe('RuntimeClient.startSession', () => {
  /** The real (unmocked) client class, for the SDK-level assertions. */
  async function actualRuntimeClient() {
    const actual = await vi.importActual<typeof import('agentarts-sdk/sdk/service/runtime-client')>(
      'agentarts-sdk/sdk/service/runtime-client',
    );
    return actual.RuntimeClient;
  }

  it('has a startSession method', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    expect(typeof RuntimeClientClass.prototype.startSession).toBe('function');
  });

  it('posts to the sessions-start path', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://data.example.com' });
    const mockData = vi
      .spyOn(RuntimeClientClass.prototype, '_data')
      .mockResolvedValue(
        new RequestResult({ success: true, statusCode: 200, data: MOCK_RESPONSE }),
      );

    const result = await instance.startSession('myagent');

    expect(mockData).toHaveBeenCalledTimes(1);
    const [method, path] = mockData.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(path).toContain('sessions-start');
    expect(path).toContain('myagent');
    expect(result).toEqual(MOCK_RESPONSE);
  });

  it('sends the bearer token as an Authorization header', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://data.example.com' });
    const mockData = vi.spyOn(RuntimeClientClass.prototype, '_data').mockResolvedValue(
      new RequestResult({
        success: true,
        statusCode: 200,
        data: { data: { session_id: 'session-xyz' } },
      }),
    );

    await instance.startSession('myagent', { bearerToken: 'test-token' });

    const options = mockData.mock.calls[0]![2] as { headers: Record<string, string> };
    expect(options.headers['Authorization']).toBe('Bearer test-token');
  });

  it('raises on failure', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://data.example.com' });
    vi.spyOn(RuntimeClientClass.prototype, '_data').mockResolvedValue(
      new RequestResult({
        success: false,
        statusCode: 500,
        error: 'Internal error',
      }),
    );

    await expect(instance.startSession('myagent')).rejects.toThrow('start_session failed');
  });
});

describe('startSessionCmd', () => {
  it('is exported', () => {
    expect(typeof startSessionCmd).toBe('function');
  });

  it('is registered in the runtime command group', () => {
    const names = createRuntimeAppCommand().commands.map((command) => command.name());
    expect(names).toContain('start-session');
  });

  it('prints the raw response', async () => {
    const printSpy = vi.spyOn(toolkitConsole, 'print').mockImplementation(() => undefined);
    const panelSpy = vi.spyOn(toolkitConsole, 'printPanel').mockImplementation(() => undefined);
    const operation = vi.mocked(startRuntimeSession);
    operation.mockResolvedValue({ data: { session_id: 'session-abc-123' } });

    const exitCode = await startSessionCmd({ agent: 'myagent', skipSslVerification: false });

    expect(exitCode).toBe(0);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith({
      agentName: 'myagent',
      region: null,
      bearerToken: null,
      endpoint: null,
      skipSslVerification: false,
      userId: null,
    });
    expect(printSpy).toHaveBeenCalled();
    expect(panelSpy).toHaveBeenCalled();
  });

  it('passes the bearer token through', async () => {
    vi.spyOn(toolkitConsole, 'print').mockImplementation(() => undefined);
    vi.spyOn(toolkitConsole, 'printPanel').mockImplementation(() => undefined);
    const operation = vi.mocked(startRuntimeSession);
    operation.mockResolvedValue({ data: { session_id: 'session-xyz' } });

    await startSessionCmd({
      agent: 'myagent',
      bearerToken: 'test-token',
      skipSslVerification: false,
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith({
      agentName: 'myagent',
      region: null,
      bearerToken: 'test-token',
      endpoint: null,
      skipSslVerification: false,
      userId: null,
    });
  });
});
