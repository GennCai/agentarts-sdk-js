/**
 * CLI runtime e2e against a deployed agent (billable tier).
 *
 * Ported from `tests/integration/toolkit/test_cli_deployed_runtime.py`.
 *
 * Python builds the live agent through the session-scoped
 * `deployed_runtime_agent` fixture (`agentarts init → config → deploy`: Docker
 * build + SWR push + cloud runtime create) and reuses it here; `destroy` runs
 * as the fixture's session-end teardown. That fixture is **not ported** (it
 * needs Docker plus a long, billable build), so these tests target an existing
 * deployed project instead:
 *
 * - `AGENTARTS_TEST_RUNTIME_AGENT_NAME` — the deployed agent's name
 * - `AGENTARTS_TEST_DEPLOY_PROJECT_DIR` — its project dir (contains the
 *   `.agentarts_config.yaml` written by `agentarts deploy`)
 *
 * Everything is gated behind Docker + credentials + ALLOW_CREATE +
 * RUN_BILLABLE, so it skips by default. All CLI invokes run with cwd = the
 * deployed project dir, so the CLI resolves the data-plane endpoint from
 * `.agentarts_config.yaml` + a control-plane lookup (no `--endpoint` needed).
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  allowCreate,
  createCliHome,
  deployProjectDir,
  dockerAvailable,
  hasCloudCredentials,
  isCliReady,
  makeTempDir,
  removeTempDir,
  runBillable,
  runCli,
  runtimeAgentName,
} from '../_helpers.js';
import type { CliHome } from '../_helpers.js';

const CLI_READY = isCliReady();
const AGENT_NAME = runtimeAgentName();
const PROJECT_DIR = deployProjectDir();
const describeDeployed =
  hasCloudCredentials() &&
  allowCreate() &&
  runBillable() &&
  Boolean(AGENT_NAME) &&
  Boolean(PROJECT_DIR) &&
  dockerAvailable()
    ? describe
    : describe.skip;

describeDeployed('CLI against a deployed runtime (billable tier)', () => {
  let home: CliHome;
  let workDir: string;

  beforeAll(async () => {
    home = await createCliHome();
    workDir = await makeTempDir('aa-it-cli-deploy-');
  });

  afterAll(async () => {
    await removeTempDir(workDir);
    await home.dispose();
  });

  /** `agentarts runtime start-session` and return the backend session id. */
  function startSession(): string {
    const start = runCli(['runtime', 'start-session', '--agent', AGENT_NAME as string], {
      cwd: PROJECT_DIR,
      env: home.env,
      timeoutMs: 120_000,
    });
    expect(start.status, start.stderr || start.stdout).toBe(0);

    const match = /Response:\s*(\{[\s\S]*\})\s*$/.exec(start.stdout);
    expect(match, `could not find session Response in output:\n${start.stdout}`).not.toBeNull();
    // The result dict can contain raw control chars (e.g. newlines) in string
    // values; session_id may be top-level or nested under "data".
    const parsed = JSON.parse((match as RegExpExecArray)[1]) as Record<string, any>;
    const data = (parsed['data'] ?? {}) as Record<string, any>;
    const sessionId = parsed['session_id'] ?? data['session_id'];
    expect(sessionId, `no session_id in start-session response:\n${start.stdout}`).toBeTruthy();
    return String(sessionId);
  }

  function sessionArgs(sessionId: string): string[] {
    return ['--agent', AGENT_NAME as string, '--session', sessionId];
  }

  it.skipIf(!CLI_READY)('deploy wrote the agent id back to the project config', async () => {
    const config = await readFile(join(PROJECT_DIR as string, '.agentarts_config.yaml'), 'utf8');
    expect(config).toContain('agent_id');
    expect(AGENT_NAME).toBeTruthy();
  });

  it.skipIf(!CLI_READY)('invoke --mode cloud succeeds on the deployed agent', () => {
    const result = runCli(
      [
        'invoke',
        '--agent',
        AGENT_NAME as string,
        '--mode',
        'cloud',
        '{"message": "hello from deployed e2e"}',
      ],
      { cwd: PROJECT_DIR, env: home.env, timeoutMs: 900_000 },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.skipIf(!CLI_READY)('runtime start/exec/stop session lifecycle works', () => {
    const sessionId = startSession();
    try {
      const exec = runCli(['runtime', 'exec-command', ...sessionArgs(sessionId), 'echo aa-it'], {
        cwd: PROJECT_DIR,
        env: home.env,
        timeoutMs: 120_000,
      });
      expect(exec.status, exec.stderr || exec.stdout).toBe(0);
    } finally {
      runCli(['runtime', 'stop-session', ...sessionArgs(sessionId)], {
        cwd: PROJECT_DIR,
        env: home.env,
        timeoutMs: 120_000,
      });
    }
  });

  it.skipIf(!CLI_READY)(
    'runtime file transfer round-trips (best effort)',
    { timeout: 300_000 },
    async (ctx) => {
      // The file-upload endpoint may require a bearer token that an IAM-only
      // agent doesn't have (401); in that case skip rather than fail — the core
      // session lifecycle is covered by the test above.
      const sessionId = startSession();
      const localFile = join(workDir, 'aa-it-e2e.txt');
      await writeFile(localFile, 'hello-aa-it', 'utf8');
      const remoteFile = `/home/user/${basename(localFile)}`;
      const downloadFile = join(workDir, 'aa-it-e2e.dl');

      try {
        const upload = runCli(
          [
            'runtime',
            'upload-files',
            ...sessionArgs(sessionId),
            '--files',
            localFile,
            '--path',
            '/home/user/',
          ],
          { cwd: PROJECT_DIR, env: home.env, timeoutMs: 120_000 },
        );
        if (upload.status !== 0 && /401/.test(upload.stderr + upload.stdout)) {
          ctx.skip('upload-files returned 401 (IAM-only agent likely needs a bearer token)');
          return;
        }
        expect(upload.status, upload.stderr || upload.stdout).toBe(0);

        const download = runCli(
          [
            'runtime',
            'download-files',
            ...sessionArgs(sessionId),
            '--path',
            remoteFile,
            '--output',
            downloadFile,
          ],
          { cwd: PROJECT_DIR, env: home.env, timeoutMs: 120_000 },
        );
        expect(download.status, download.stderr || download.stdout).toBe(0);
      } finally {
        await unlink(localFile).catch(() => undefined);
        runCli(['runtime', 'stop-session', ...sessionArgs(sessionId)], {
          cwd: PROJECT_DIR,
          env: home.env,
          timeoutMs: 120_000,
        });
      }
    },
  );
});
