/**
 * Unit tests for the runtime deploy operation.
 *
 * Ported 1:1 from `tests/unit/toolkit/operations/runtime/test_deploy.py`.
 *
 * `patch("…deploy.RuntimeClient")` → `vi.mock` of the SDK runtime-client module
 * with the class replaced by a `vi.fn()` returning a mock client;
 * `patch("…deploy.check_docker_available")` & friends → `vi.mock` of the
 * container module with those helpers replaced; `monkeypatch.chdir(tmp_path)` →
 * `process.cwd()` stubbed to a `mkdtemp()` directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeployMode,
  createAgentartsRuntime,
  deployProject,
} from 'agentarts-sdk/toolkit/operations/runtime/deploy';
import {
  AgentArtsConfig,
  AgentArtsRuntimeConfig,
  LifecycleConfig,
  SessionStorageConfig,
  SfsTurboConfig,
  StorageConfig,
} from 'agentarts-sdk/toolkit/utils/runtime/config';

const clientMocks = vi.hoisted(() => ({ RuntimeClient: vi.fn() }));

vi.mock('agentarts-sdk/sdk/service/runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentarts-sdk/sdk/service/runtime-client')>();
  return {
    ...actual,
    RuntimeClient: clientMocks.RuntimeClient as unknown as typeof actual.RuntimeClient,
  };
});

const containerMocks = vi.hoisted(() => ({
  checkDockerAvailable: vi.fn(),
  checkDockerfileExists: vi.fn(),
  buildDockerImage: vi.fn(),
  runContainer: vi.fn(),
}));

vi.mock('agentarts-sdk/toolkit/utils/runtime/container', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('agentarts-sdk/toolkit/utils/runtime/container')>();
  return {
    ...actual,
    checkDockerAvailable: containerMocks.checkDockerAvailable,
    checkDockerfileExists: containerMocks.checkDockerfileExists,
    buildDockerImage: containerMocks.buildDockerImage,
    runContainer: containerMocks.runContainer,
  };
});

/** Mock runtime client returned by the mocked `RuntimeClient` constructor. */
interface MockRuntimeClient {
  createOrUpdateAgent: ReturnType<typeof vi.fn>;
}

const SWR_IMAGE = 'swr.cn-north-4.myhuaweicloud.com/org/repo:latest';
const SFS_ID = '12345678-1234-1234-1234-123456789012';

let tmpDir: string;
let client: MockRuntimeClient;

/** Build an agent config carrying only a runtime section. */
function runtimeConfig(init: ConstructorParameters<typeof AgentArtsRuntimeConfig>[0]) {
  return new AgentArtsConfig({ runtime: new AgentArtsRuntimeConfig(init) });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentarts-deploy-'));
  // Python `monkeypatch.chdir(tmp_path)`: the operation resolves the config file
  // through `process.cwd()`, which is stubbed instead of changing the real
  // working directory (the vitest threads pool shares one process).
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  client = {
    createOrUpdateAgent: vi.fn().mockResolvedValue({ id: 'agent-123', latest_version: 'v1' }),
  };
  clientMocks.RuntimeClient.mockImplementation(function () {
    return client;
  });
  containerMocks.checkDockerAvailable.mockResolvedValue(true);
  containerMocks.checkDockerfileExists.mockReturnValue(true);
  containerMocks.buildDockerImage.mockResolvedValue(true);
  containerMocks.runContainer.mockResolvedValue(true);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DeployMode', () => {
  it('has a local mode', () => {
    expect(DeployMode.LOCAL).toBe('local');
  });

  it('has a cloud mode', () => {
    expect(DeployMode.CLOUD).toBe('cloud');
  });
});

describe('createAgentartsRuntime', () => {
  it('creates the runtime with the default description', async () => {
    const result = await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4');

    expect(result).not.toBeNull();
    expect(result!['id']).toBe('agent-123');
  });

  it('includes the toolkit name in the default description', async () => {
    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4');

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['description']).toContain('AgentArts SDK Toolkit');
  });

  it('uses a custom description', async () => {
    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', {
      description: 'My custom description',
    });

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['description']).toBe('My custom description');
  });

  it('passes null storage config when it is not configured', async () => {
    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4');

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['storageConfig']).toBeNull();
  });

  it('passes null lifecycle config when it is not configured', async () => {
    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4');

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['lifecycleConfig']).toBeNull();
  });

  it('forwards the configured lifecycle limits', async () => {
    const agentConfig = runtimeConfig({
      lifecycleConfig: new LifecycleConfig({
        idleSessionTimeoutSec: 600,
        maxAliveTimeSec: 86400,
      }),
    });

    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', { agentConfig });

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['lifecycleConfig']).toEqual({
      idle_session_timeout_sec: 600,
      max_alive_time_sec: 86400,
    });
  });

  it('treats an all-null placeholder storage config as unset', async () => {
    // Mirrors the null block written by `init`'s createConfigFile.
    const agentConfig = runtimeConfig({
      storageConfig: new StorageConfig({ sfsTurbo: new SfsTurboConfig() }),
    });

    const result = await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', {
      agentConfig,
    });

    expect(result).not.toBeNull();
    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['storageConfig']).toBeNull();
  });

  it('does not block a partial storage config without an id', async () => {
    // Requirement: deploy must NOT block when the user hasn't configured
    // storage. A storage_config with only sfs_path/mount_path but no
    // sfs_turbo_id is treated as unset (no blocking, nothing sent).
    const agentConfig = runtimeConfig({
      storageConfig: new StorageConfig({
        sfsTurbo: new SfsTurboConfig({ sfsPath: '/share/sub', mountPath: '/data' }),
      }),
    });

    const result = await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', {
      agentConfig,
    });

    expect(result).not.toBeNull();
    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['storageConfig']).toBeNull();
  });

  it('forwards a populated storage config', async () => {
    const agentConfig = runtimeConfig({
      storageConfig: new StorageConfig({
        sfsTurbo: new SfsTurboConfig({
          sfsTurboId: SFS_ID,
          sfsPath: '/share/sub',
          mountPath: '/data',
          readOnly: true,
        }),
      }),
    });

    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', { agentConfig });

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['storageConfig']).toEqual({
      sfs_turbo: [
        {
          sfs_turbo_id: SFS_ID,
          sfs_path: '/share/sub',
          mount_path: '/data',
          read_only: true,
        },
      ],
    });
  });

  it('forwards session storage on its own', async () => {
    const agentConfig = runtimeConfig({
      storageConfig: new StorageConfig({
        sessionStorage: new SessionStorageConfig({ mountPath: '/home/user/sessions' }),
      }),
    });

    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', { agentConfig });

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['storageConfig']).toEqual({
      session_storage: { mount_path: '/home/user/sessions' },
    });
  });

  it('forwards both storage fields', async () => {
    const agentConfig = runtimeConfig({
      storageConfig: new StorageConfig({
        sfsTurbo: new SfsTurboConfig({ sfsTurboId: SFS_ID, mountPath: '/data' }),
        sessionStorage: new SessionStorageConfig({ mountPath: '/home/user/sessions' }),
      }),
    });

    await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', { agentConfig });

    const options = client.createOrUpdateAgent.mock.calls[0]![1] as Record<string, any>;
    expect(options['storageConfig']).toEqual({
      sfs_turbo: [{ sfs_turbo_id: SFS_ID, mount_path: '/data' }],
      session_storage: { mount_path: '/home/user/sessions' },
    });
  });

  it('requires a mount path when the sfs_turbo_id is set', async () => {
    const agentConfig = runtimeConfig({
      storageConfig: new StorageConfig({
        sfsTurbo: new SfsTurboConfig({ sfsTurboId: SFS_ID, sfsPath: '/share/sub' }),
      }),
    });

    const result = await createAgentartsRuntime('test-agent', SWR_IMAGE, 'cn-north-4', {
      agentConfig,
    });

    expect(result).toBeNull();
    expect(client.createOrUpdateAgent).not.toHaveBeenCalled();
  });
});

describe('deployProject', () => {
  it('returns false when no configuration file exists', async () => {
    const result = await deployProject();

    expect(result).toBe(false);
  });

  it('returns false when docker is not available', async () => {
    writeFileSync(
      join(tmpDir, '.agentarts_config.yaml'),
      `
default_agent: test-agent
agents:
  test-agent:
    base:
      name: test-agent
      entrypoint: agent:app
      region: cn-north-4
    swr_config:
      organization: test-org
      repository: test-repo
`,
    );
    containerMocks.checkDockerAvailable.mockResolvedValue(false);

    const result = await deployProject();

    expect(result).toBe(false);
  });

  it('runs the container in local mode', async () => {
    writeFileSync(
      join(tmpDir, '.agentarts_config.yaml'),
      `
default_agent: test-agent
agents:
  test-agent:
    base:
      name: test-agent
      entrypoint: agent:app
      region: cn-north-4
    swr_config:
      organization: test-org
      repository: test-repo
    runtime:
      invoke_config:
        port: 8080
`,
    );
    writeFileSync(join(tmpDir, 'Dockerfile'), 'FROM python:3.10-slim');

    const result = await deployProject({ mode: DeployMode.LOCAL });

    expect(result).toBe(true);
    expect(containerMocks.buildDockerImage).toHaveBeenCalled();
    expect(containerMocks.runContainer).toHaveBeenCalled();
  });
});
