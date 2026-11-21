/**
 * Unit tests for the runtime exec-command operation.
 *
 * Ported 1:1 from `tests/unit/toolkit/operations/runtime/test_exec_command.py`.
 *
 * `pytest.mark.parametrize` → `it.each`; `patch("…_get_data_endpoint")` and
 * `patch("…RuntimeClient")` → `vi.mock` of the shared `invoke` module and of the
 * SDK runtime-client module; `monkeypatch.chdir(tmp_path)` → `process.cwd()`
 * stubbed to a `mkdtemp()` directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _needsShell,
  buildCommandArray,
  execRuntimeCommand,
} from 'agentarts-sdk/toolkit/operations/runtime/exec-command';

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

/** Mock runtime client returned by the mocked `RuntimeClient` constructor. */
interface MockRuntimeClient {
  setAuthToken: ReturnType<typeof vi.fn>;
  execCommand: ReturnType<typeof vi.fn>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONFIG = `
default_agent: test-agent
agents:
  test-agent:
    base:
      name: test-agent
      region: cn-north-4
    runtime:
      agent_id: agent-123
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

let tmpDir: string;
let client: MockRuntimeClient;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentarts-exec-command-'));
  // Python `monkeypatch.chdir(tmp_path)`: the operation resolves the config file
  // through `process.cwd()`, which is stubbed instead of changing the real
  // working directory (the vitest threads pool shares one process).
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  client = {
    setAuthToken: vi.fn(),
    execCommand: vi.fn().mockResolvedValue({ stdout: 'output' }),
  };
  clientMocks.RuntimeClient.mockImplementation(function () {
    return client;
  });
  invokeMocks.getDataEndpoint.mockResolvedValue('https://test.example.com');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('_needsShell', () => {
  it.each([
    ["echo '1214' > test1.txt", 'redirection outside quotes'],
    ['cat f | grep x', 'pipe'],
    ['cd /tmp && pwd', '&&'],
    ['cd /tmp || pwd', '||'],
    ['echo a;b', ';'],
    ['sleep 1 &', 'background &'],
    ['echo hi $(date)', 'command substitution'],
    ['echo hi `date`', 'backtick'],
    ['echo a>>f', '>> redirection'],
  ])('detects shell constructs in %j (%s)', (command) => {
    expect(_needsShell(command)).toBe(true);
  });

  it.each([
    ['ls -la', 'plain command'],
    ['echo 1214', 'plain echo'],
    ['echo "a > b"', '> inside double quotes is literal'],
    ["echo 'a;b'", '; inside single quotes is literal'],
    ["find . -name '*.py'", 'glob not in the operator set'],
    ['grep ">" f', '> quoted is literal'],
    ["curl 'http://x?a=1&b=2'", '& inside quotes is literal'],
  ])('does not detect a shell construct in %j (%s)', (command) => {
    expect(_needsShell(command)).toBe(false);
  });
});

describe('buildCommandArray', () => {
  it('keeps a plain command in docker exec form', () => {
    expect(buildCommandArray('ls -la /home')).toEqual(['ls', '-la', '/home']);
  });

  it('wraps a shell construct with sh -c', () => {
    const command = 'echo 1214 > test1.txt';
    expect(buildCommandArray(command)).toEqual(['sh', '-c', command]);
  });

  it('wraps with the original string, not a shell-joined one', () => {
    // `sh -c` only uses its first argument as the script; the array must be
    // exactly `["sh", "-c", <original>]` so `sh` re-parses quotes and operators
    // consistently.
    const command = "echo '1214' > test1.txt";
    const argv = buildCommandArray(command);
    expect(argv[0]).toBe('sh');
    expect(argv[1]).toBe('-c');
    expect(argv[2]).toBe(command);
  });

  it('keeps quoted metacharacters in exec form', () => {
    expect(buildCommandArray('echo "a > b"')).toEqual(['echo', 'a > b']);
  });

  it('passes an explicit sh -c wrapper through', () => {
    // No shell operators outside quotes → stays exec form as-is, which already
    // runs `sh -c` on the backend. Users can force a shell this way.
    expect(buildCommandArray('sh -c "echo 1214 > f.txt"')).toEqual([
      'sh',
      '-c',
      'echo 1214 > f.txt',
    ]);
  });

  it('raises when nothing is left after splitting', async () => {
    expect(() => buildCommandArray('   ')).toThrow(/empty/);
  });
});

describe('execRuntimeCommand', () => {
  it('raises for an empty command', async () => {
    await expect(execRuntimeCommand({ command: '' })).rejects.toThrow('Command is required');
  });

  it('raises for a whitespace-only command', async () => {
    await expect(execRuntimeCommand({ command: '   ' })).rejects.toThrow('Command cannot be empty');
  });

  it('parses the command string', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.execCommand.mockResolvedValue({ stdout: 'output' });

    const result = await execRuntimeCommand({ command: 'ls -la /home' });

    expect(result).toEqual({ stdout: 'output' });
    expect(client.execCommand.mock.calls[0]![2]).toEqual(['ls', '-la', '/home']);
  });

  it('supports chunked mode', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    async function* lines(): AsyncGenerator<string> {
      yield 'line1';
      yield 'line2';
    }
    const generator = lines();
    client.execCommand.mockResolvedValue(generator);

    const result = await execRuntimeCommand({ command: 'echo hello', chunked: true });

    expect(typeof (result as any)[Symbol.asyncIterator]).toBe('function');
    expect((client.execCommand.mock.calls[0]![3] as Record<string, any>)['chunked']).toBe(true);
  });

  it('raises when no agent can be resolved', async () => {
    await expect(execRuntimeCommand({ command: 'ls' })).rejects.toThrow('Agent name is required');
  });

  it('raises when the agent has no data endpoint', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    invokeMocks.getDataEndpoint.mockResolvedValue(null);

    await expect(execRuntimeCommand({ command: 'ls' })).rejects.toThrow('No data endpoint');
  });

  it('passes the session id through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.execCommand.mockResolvedValue({ stdout: '' });

    await execRuntimeCommand({ command: 'pwd', sessionId: 'session-123' });

    expect(client.execCommand.mock.calls[0]![1]).toBe('session-123');
  });

  it('auto-generates a session id when none is given', async () => {
    // Mirrors `invoke`: one is auto-generated instead of crashing in the signer
    // on a null header.
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.execCommand.mockResolvedValue({ stdout: '' });

    await execRuntimeCommand({ command: 'pwd' });

    const generated = client.execCommand.mock.calls[0]![1] as string;
    expect(generated).not.toBeNull();
    expect(generated).toMatch(UUID_PATTERN);
  });

  it('uses the explicitly requested agent', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), TWO_AGENTS_CONFIG);
    client.execCommand.mockResolvedValue({ stdout: '' });

    await execRuntimeCommand({ command: 'ls', agentName: 'custom-agent' });

    expect(client.execCommand.mock.calls[0]![0]).toBe('custom-agent');
  });

  it('rejects a timeout of zero', async () => {
    await expect(execRuntimeCommand({ command: 'ls', timeout: 0 })).rejects.toThrow(
      'Timeout must be a positive number',
    );
  });

  it('rejects a negative timeout', async () => {
    await expect(execRuntimeCommand({ command: 'ls', timeout: -10 })).rejects.toThrow(
      'Timeout must be a positive number',
    );
  });

  it('rejects a timeout above the maximum', async () => {
    await expect(execRuntimeCommand({ command: 'ls', timeout: 4000 })).rejects.toThrow(
      'Timeout exceeds maximum allowed value',
    );
  });

  it('passes a valid timeout through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.execCommand.mockResolvedValue({ stdout: '' });

    await execRuntimeCommand({ command: 'ls', timeout: 120 });

    expect((client.execCommand.mock.calls[0]![3] as Record<string, any>)['timeout']).toBe(120);
  });
});
