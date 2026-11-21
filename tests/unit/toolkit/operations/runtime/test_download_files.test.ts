/**
 * Unit tests for the runtime download-files operation.
 *
 * Ported 1:1 from `tests/unit/toolkit/operations/runtime/test_download_files.py`
 * (including the `RuntimeClient.download_files` section).
 *
 * The Python tests build their tar archive with `tarfile`; Node has no built-in
 * tar writer, so {@link makeTar} writes the small ustar subset the port's
 * `extractTarArchive()` understands. `StreamDownloadResult` is the real class —
 * only its raw byte stream is faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  StreamDownloadResult,
  type RuntimeClient as RuntimeClientType,
} from 'agentarts-sdk/sdk/service/runtime-client';
import type { RequestResult } from 'agentarts-sdk/sdk/service/http-client';
import { downloadRuntimeFiles } from 'agentarts-sdk/toolkit/operations/runtime/download-files';

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
  downloadFiles: ReturnType<typeof vi.fn>;
}

/** Build a `StreamDownloadResult` whose byte stream yields `chunks`. */
function streamResult(init: {
  success?: boolean;
  contentType?: string;
  error?: string | null;
  chunks?: Buffer[];
}): StreamDownloadResult {
  const rawResponse = {
    async *iterBytes(): AsyncGenerator<Uint8Array> {
      for (const chunk of init.chunks ?? []) {
        yield chunk;
      }
    },
    close: vi.fn(),
  } as unknown as RequestResult;
  return new StreamDownloadResult({
    success: init.success ?? true,
    statusCode: init.success === false ? 404 : 200,
    contentType: init.contentType ?? 'application/octet-stream',
    error: init.error ?? null,
    rawResponse,
  });
}

/** Write a single-entry ustar archive (what the Python test builds with `tarfile`). */
function makeTar(entries: Array<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');

    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentarts-download-files-'));
  // Python `monkeypatch.chdir(tmp_path)`: the operation resolves the config file
  // through `process.cwd()`, which is stubbed instead of changing the real
  // working directory (the vitest threads pool shares one process).
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  client = {
    setAuthToken: vi.fn(),
    downloadFiles: vi.fn().mockResolvedValue(streamResult({ chunks: [Buffer.from('test')] })),
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

describe('downloadRuntimeFiles', () => {
  it('raises for an empty path', async () => {
    await expect(downloadRuntimeFiles({ path: '', sessionId: 'session-123' })).rejects.toThrow(
      'Path is required',
    );
  });

  it('raises when no session id is given', async () => {
    await expect(downloadRuntimeFiles({ path: '/home/user/test.txt' })).rejects.toThrow(
      'Session ID is required',
    );
  });

  it('raises when no agent can be resolved', async () => {
    await expect(
      downloadRuntimeFiles({ path: '/home/user/test.txt', sessionId: 'session-123' }),
    ).rejects.toThrow('Agent name is required');
  });

  it('keeps a relative remote path as-is', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.downloadFiles.mockResolvedValue(streamResult({ chunks: [Buffer.from('test content')] }));

    const outputPath = join(tmpDir, 'output.txt');
    const result = await downloadRuntimeFiles({
      path: 'test.txt',
      output: outputPath,
      sessionId: 'session-123',
    });

    expect(result['saved_path']).toBe(outputPath);
    expect(client.downloadFiles.mock.calls[0]![2]).toBe('test.txt');
  });

  it('preserves a full remote path', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.downloadFiles.mockResolvedValue(streamResult({ chunks: [Buffer.from('test content')] }));

    await downloadRuntimeFiles({
      path: '/home/user/custom/file.txt',
      output: join(tmpDir, 'output.txt'),
      sessionId: 'session-123',
    });

    expect(client.downloadFiles.mock.calls[0]![2]).toBe('/home/user/custom/file.txt');
  });

  it('extracts a recursive tar download', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    const archive = makeTar([{ name: 'test_content.txt', content: 'test content' }]);
    client.downloadFiles.mockResolvedValue(
      streamResult({ contentType: 'application/x-tar', chunks: [archive] }),
    );

    const outputDir = join(tmpDir, 'output_dir');
    const result = await downloadRuntimeFiles({
      path: '/home/user/data',
      output: outputDir,
      recursive: true,
      sessionId: 'session-123',
    });

    expect(result['saved_path']).toBe(outputDir);
    expect((client.downloadFiles.mock.calls[0]![3] as Record<string, any>)['recursive']).toBe(true);
    expect(readFileSync(join(outputDir, 'test_content.txt'), 'utf8')).toBe('test content');
  });

  it('passes the session id through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await downloadRuntimeFiles({
      path: '/home/user/test.txt',
      output: join(tmpDir, 'output.txt'),
      sessionId: 'session-123',
    });

    expect(client.downloadFiles.mock.calls[0]![1]).toBe('session-123');
  });

  it('passes the bearer token through', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);

    await downloadRuntimeFiles({
      path: '/home/user/test.txt',
      output: join(tmpDir, 'output.txt'),
      sessionId: 'session-123',
      bearerToken: 'test-token',
    });

    expect((client.downloadFiles.mock.calls[0]![3] as Record<string, any>)['bearerToken']).toBe(
      'test-token',
    );
  });

  it('raises when the download fails', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    client.downloadFiles.mockResolvedValue(
      streamResult({ success: false, contentType: 'application/json', error: 'File not found' }),
    );

    await expect(
      downloadRuntimeFiles({ path: '/home/user/test.txt', sessionId: 'session-123' }),
    ).rejects.toThrow('Download failed');
  });

  it('raises when the agent has no data endpoint', async () => {
    writeFileSync(join(tmpDir, '.agentarts_config.yaml'), CONFIG);
    invokeMocks.getDataEndpoint.mockResolvedValue(null);

    await expect(
      downloadRuntimeFiles({ path: '/home/user/test.txt', sessionId: 'session-123' }),
    ).rejects.toThrow('No data endpoint');
  });
});

describe('RuntimeClient.downloadFiles', () => {
  /** The real (unmocked) client class, for the SDK-level assertions. */
  async function actualRuntimeClient(): Promise<typeof RuntimeClientType> {
    const actual = await vi.importActual<typeof import('agentarts-sdk/sdk/service/runtime-client')>(
      'agentarts-sdk/sdk/service/runtime-client',
    );
    return actual.RuntimeClient;
  }

  it('requests the download-files endpoint', async () => {
    const RuntimeClientClass = await actualRuntimeClient();
    const instance = new RuntimeClientClass({ dataEndpoint: 'https://test.example.com' });
    const expected = streamResult({ chunks: [Buffer.from('test')] });
    const mockStream = vi
      .spyOn(RuntimeClientClass.prototype, '_requestStream')
      .mockResolvedValue(expected);

    const result = await instance.downloadFiles('myagent', 'session-123', '/test.txt');

    expect(result).toBe(expected);
    const [method, path] = mockStream.mock.calls[0]!;
    expect(method).toBe('GET');
    expect(String(path)).toContain('/runtimes/myagent/download-files');
  });
});
