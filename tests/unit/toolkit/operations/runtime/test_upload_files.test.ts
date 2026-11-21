/**
 * Unit tests for the runtime upload-files operation.
 *
 * Ported 1:1 from `tests/unit/toolkit/operations/runtime/test_upload_files.py`
 * (including the `RuntimeClient.upload_files` section).
 *
 * `patch("…_check_file_transfer_enabled")` / `_get_data_endpoint` → `vi.mock` of
 * the shared `invoke` module; `patch("…RuntimeClient")` → `vi.mock` of the SDK
 * runtime-client module; `tempfile.NamedTemporaryFile` → a file created in the
 * per-test `mkdtemp()` directory (with `process.cwd()` stubbed to it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uploadRuntimeFiles } from 'agentarts-sdk/toolkit/operations/runtime/upload-files';
import { RequestResult } from 'agentarts-sdk/sdk/service/http-client';

const invokeMocks = vi.hoisted(() => ({
  checkFileTransferEnabled: vi.fn(),
  getDataEndpoint: vi.fn(),
}));

vi.mock('agentarts-sdk/toolkit/operations/runtime/invoke', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('agentarts-sdk/toolkit/operations/runtime/invoke')>();
  return {
    ...actual,
    _checkFileTransferEnabled: invokeMocks.checkFileTransferEnabled,
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

/** Mock runtime client returned by the mocked `RuntimeClient` constructor. */
interface MockRuntimeClient {
  setAuthToken: ReturnType<typeof vi.fn>;
  uploadFiles: ReturnType<typeof vi.fn>;
}

const CONFIG = `
default_agent: test-agent
agents:
  test-agent:
    base:
      name: test-agent
      region: cn-north-4
`;

let tmpDir: string;
let client: MockRuntimeClient;
let localFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentarts-upload-files-'));
  // Python `monkeypatch.chdir(tmp_path)`: the operation resolves the config file
  // through `process.cwd()`, which is stubbed instead of changing the real
  // working directory (the vitest threads pool shares one process).
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  localFile = join(tmpDir, 'test-content.bin');
  writeFileSync(localFile, 'test content');

  client = {
    setAuthToken: vi.fn(),
    uploadFiles: vi.fn().mockResolvedValue({ status: 'uploaded' }),
  };
  clientMocks.RuntimeClient.mockImplementation(function () {
    return client;
  });
  invokeMocks.checkFileTransferEnabled.mockResolvedValue(undefined);
  invokeMocks.getDataEndpoint.mockResolvedValue('https://test.example.com');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('uploadRuntimeFiles', () => {
  it('raises when no files are given', async () => {
    await expect(uploadRuntimeFiles({ files: [], sessionId: 'session-123' })).rejects.toThrow(
      'Files are required',
    );
  });

  it('raises when no agent can be resolved', async () => {
    await expect(
      uploadRuntimeFiles({
        files: [{ path: '/test.txt', localFile: '/tmp/test.txt' }],
        sessionId: 'session-123',
      }),
    ).rejects.toThrow('Agent name is required');
  });

  it('raises when no session id is given', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await expect(uploadRuntimeFiles({ files: [{ path: '/test.txt', localFile }] })).rejects.toThrow(
      'Session ID is required',
    );
  });

  it('passes the remote path to the client', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    const result = await uploadRuntimeFiles({
      files: [{ localFile }],
      path: '/app/data/',
      sessionId: 'session-123',
    });

    expect(result['status']).toBe('uploaded');
    const options = client.uploadFiles.mock.calls[0]![3] as Record<string, any>;
    expect(options['path']).toBe('/app/data/');
  });

  it('defaults the remote path to /tmp/', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await uploadRuntimeFiles({ files: [{ localFile }], sessionId: 'session-123' });

    const options = client.uploadFiles.mock.calls[0]![3] as Record<string, any>;
    expect(options['path']).toBe('/tmp/');
  });

  it('passes multiple files through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    const secondFile = join(tmpDir, 'second.bin');
    writeFileSync(secondFile, 'content2');
    client.uploadFiles.mockResolvedValue({ status: 'uploaded', files: 2 });

    const result = await uploadRuntimeFiles({
      files: [{ localFile }, { localFile: secondFile }],
      path: '/tmp/',
      sessionId: 'session-123',
    });

    expect(result['files']).toBe(2);
    const filesArg = client.uploadFiles.mock.calls[0]![2] as unknown[];
    expect(filesArg).toHaveLength(2);
    const options = client.uploadFiles.mock.calls[0]![3] as Record<string, any>;
    expect(options['path']).toBe('/tmp/');
  });

  it('passes the ownership metadata through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await uploadRuntimeFiles({
      files: [{ path: '/home/user/test.txt', localFile }],
      sessionId: 'session-123',
      fileUserId: 1001,
      fileGroupId: 1001,
      fileMode: '0755',
    });

    const options = client.uploadFiles.mock.calls[0]![3] as Record<string, any>;
    expect(options['fileUserId']).toBe(1001);
    expect(options['fileGroupId']).toBe(1001);
    expect(options['fileMode']).toBe('0755');
  });

  it('leaves the ownership metadata unset by default', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await uploadRuntimeFiles({
      files: [{ path: '/home/user/test.txt', localFile }],
      sessionId: 'session-123',
    });

    const options = client.uploadFiles.mock.calls[0]![3] as Record<string, any>;
    expect(options['fileUserId']).toBeNull();
    expect(options['fileGroupId']).toBeNull();
    expect(options['fileMode']).toBeNull();
  });

  it('passes the bearer token through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await uploadRuntimeFiles({
      files: [{ path: '/home/user/test.txt', localFile }],
      sessionId: 'session-123',
      bearerToken: 'test-token',
    });

    const options = client.uploadFiles.mock.calls[0]![3] as Record<string, any>;
    expect(options['bearerToken']).toBe('test-token');
  });

  it('raises when the agent has no data endpoint', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    invokeMocks.getDataEndpoint.mockResolvedValue(null);

    await expect(
      uploadRuntimeFiles({
        files: [{ path: '/test.txt', localFile }],
        sessionId: 'session-123',
      }),
    ).rejects.toThrow('No data endpoint');
  });
});

describe('RuntimeClient.uploadFiles', () => {
  /** The real (unmocked) client class, for the SDK-level assertions. */
  async function actualRuntimeClient() {
    const actual = await vi.importActual<typeof import('agentarts-sdk/sdk/service/runtime-client')>(
      'agentarts-sdk/sdk/service/runtime-client',
    );
    return actual.RuntimeClient;
  }

  it('posts to the upload-files endpoint', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://test.example.com' });
    const mockData = vi
      .spyOn(RuntimeClientClass.prototype, '_data')
      .mockResolvedValue(
        new RequestResult({ success: true, statusCode: 200, data: { status: 'uploaded' } }),
      );

    await instance.uploadFiles('myagent', 'session-123', [{ path: '/test.txt', content: 'test' }]);

    const path = mockData.mock.calls[0]![1] as string;
    expect(path).toContain('/runtimes/myagent/upload-files');
  });

  it('includes the user, group and mode query parameters', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://test.example.com' });
    const mockData = vi
      .spyOn(RuntimeClientClass.prototype, '_data')
      .mockResolvedValue(
        new RequestResult({ success: true, statusCode: 200, data: { status: 'uploaded' } }),
      );

    await instance.uploadFiles('myagent', 'session-123', [{ path: '/test.txt', content: 'test' }], {
      fileUserId: 1001,
      fileGroupId: 1002,
      fileMode: '0755',
    });

    const options = mockData.mock.calls[0]![2] as { params: Record<string, any> };
    expect(options.params['user_id']).toBe(1001);
    expect(options.params['group_id']).toBe(1002);
    expect(options.params['file_mode']).toBe('0755');
  });

  it('puts the path in query parameters for multipart uploads', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://test.example.com' });
    const mockData = vi.spyOn(RuntimeClientClass.prototype, '_data').mockResolvedValue(
      new RequestResult({
        success: true,
        statusCode: 200,
        data: { status: 'uploaded', files: 2 },
      }),
    );

    await instance.uploadFiles(
      'myagent',
      'session-123',
      [
        { content: 'test1', filename: 'file1.txt' },
        { content: 'test2', filename: 'file2.txt' },
      ],
      { path: '/app/data/' },
    );

    const options = mockData.mock.calls[0]![2] as {
      params: Record<string, any>;
      files: Record<string, File[]>;
    };
    expect(options.params['path']).toBe('/app/data/');
    expect(Object.keys(options.files)).toEqual(['file']);
    expect(options.files['file']).toHaveLength(2);
  });
});
