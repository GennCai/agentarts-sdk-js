/**
 * Local CLI e2e tests (default tier — no credentials, no Docker, no cloud).
 *
 * Ported 1:1 from `tests/integration/toolkit/test_cli_local.py`.
 *
 * Drives the real `agentarts` CLI as a subprocess (`node dist/cli.js …`) for
 * `init` / `config` (asserting on generated files) and for the blocking `dev`
 * server. Safe to run in CI unconditionally — when `dist/cli.js` has not been
 * built yet every case skips with a hint.
 *
 * Port note: the Python suite also covers the `google-adk` template; the Node
 * port intentionally dropped it (`AGENT_TEMPLATE_TYPES` = basic/langchain/
 * langgraph), so it is not exercised here.
 */

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';

import {
  CLI_DIST_PATH,
  cliEnv,
  findFreePort,
  isCliReady,
  makeTempDir,
  makeTempDirIn,
  removeTempDir,
  runCli,
  sleep,
  spawnCli,
} from '../_helpers.js';

const CLI_READY = isCliReady();
const REGION = 'cn-southwest-2';
const TEMPLATES = ['basic', 'langchain', 'langgraph'];

describe('CLI local commands', () => {
  let rootDir: string;
  let cliHome: string;
  let env: NodeJS.ProcessEnv;
  let workDir: string;

  beforeAll(async () => {
    rootDir = await makeTempDir('aa-it-cli-');
    cliHome = join(rootDir, 'home');
    await mkdir(join(cliHome, '.agentarts'), { recursive: true });
    // Pre-create the completion marker so the CLI never installs shell
    // completion into the real profile (and never pollutes stdout).
    await writeFile(join(cliHome, '.agentarts', '.completion_shown'), '');
    env = cliEnv(cliHome);
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  beforeEach(async () => {
    workDir = await makeTempDirIn(rootDir, 'work-');
  });

  // -------------------------------------------------------------------------
  // Smoke
  // -------------------------------------------------------------------------

  it.skipIf(!CLI_READY)('--version prints a version', () => {
    const result = runCli(['--version'], { cwd: workDir, env });
    expect(result.status).toBe(0);
    expect(/agentarts|\d+\.\d+/i.test(result.stdout + result.stderr)).toBe(true);
  });

  it.skipIf(!CLI_READY)('--help succeeds', () => {
    const result = runCli(['--help'], { cwd: workDir, env });
    expect(result.status).toBe(0);
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  for (const template of TEMPLATES) {
    it.skipIf(!CLI_READY)(`init creates the ${template} project files`, () => {
      const result = runCli(['init', '-n', 'myagent', '-t', template, '-r', REGION], {
        cwd: workDir,
        env,
      });
      expect(result.status, result.stderr).toBe(0);

      const project = join(workDir, 'myagent');
      expect(
        exists(join(project, '.agentarts_config.yaml')),
        '.agentarts_config.yaml missing',
      ).toBe(true);
      expect(exists(join(project, 'Dockerfile')), 'Dockerfile missing').toBe(true);
      // Python templates ship `agent.py` + `requirements.txt`; the Node port may
      // ship `agent.ts` + `package.json` instead, so accept either scaffold.
      expect(
        exists(join(project, 'agent.py')) || exists(join(project, 'agent.ts')),
        'agent.py / agent.ts missing',
      ).toBe(true);
      expect(
        exists(join(project, 'requirements.txt')) || exists(join(project, 'package.json')),
        'requirements.txt / package.json missing',
      ).toBe(true);
    });
  }

  it.skipIf(!CLI_READY)('init -p writes into the given directory', async () => {
    const target = join(workDir, 'sub');
    await mkdir(target);

    const result = runCli(['init', '-n', 'myagent', '-t', 'basic', '-r', REGION, '-p', target], {
      cwd: workDir,
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(exists(join(target, 'myagent', '.agentarts_config.yaml'))).toBe(true);
  });

  it.skipIf(!CLI_READY)('init rejects an invalid agent name', () => {
    // A name with invalid characters must fail (uppercase is normalised).
    const result = runCli(['init', '-n', 'Bad_Name!', '-t', 'basic', '-r', REGION], {
      cwd: workDir,
      env,
    });
    expect(result.status).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // config
  // -------------------------------------------------------------------------

  /**
   * Add an agent with every flag the callback would otherwise prompt for.
   *
   * A subprocess has no interactive stdin, so an unhandled prompt would abort
   * the command.
   */
  function addAgent(name = 'myagent'): ReturnType<typeof runCli> {
    return runCli(
      [
        'config',
        '-n',
        name,
        '-e',
        'agent:app',
        '-r',
        REGION,
        '-d',
        'requirements.txt',
        '--swr-org',
        'o',
        '--swr-repo',
        'r',
      ],
      { cwd: workDir, env },
    );
  }

  it.skipIf(!CLI_READY)('config add writes the YAML and config list works', async () => {
    const result = addAgent();
    expect(result.status, result.stderr).toBe(0);

    const configPath = join(workDir, '.agentarts_config.yaml');
    expect(exists(configPath)).toBe(true);
    expect(await readText(configPath)).toContain('myagent');

    const listed = runCli(['config', 'list'], { cwd: workDir, env });
    expect(listed.status).toBe(0);
  });

  it.skipIf(!CLI_READY)('config set/get round-trips a value', async () => {
    addAgent();
    expect(
      runCli(['config', 'set', 'base.description', 'hello', '-a', 'myagent'], {
        cwd: workDir,
        env,
      }).status,
    ).toBe(0);

    // Assert the value landed in the YAML (robust vs formatted stdout capture).
    expect(await readText(join(workDir, '.agentarts_config.yaml'))).toContain('hello');
    expect(
      runCli(['config', 'get', 'base.description', '-a', 'myagent'], {
        cwd: workDir,
        env,
      }).status,
    ).toBe(0);
  });

  it.skipIf(!CLI_READY)('config set-env / list-env / remove-env work', async () => {
    addAgent();
    const configPath = join(workDir, '.agentarts_config.yaml');

    expect(
      runCli(['config', 'set-env', 'MY_VAR', 'val', '-a', 'myagent'], {
        cwd: workDir,
        env,
      }).status,
    ).toBe(0);
    const withVar = await readText(configPath);
    expect(withVar).toContain('MY_VAR');
    expect(withVar).toContain('val');

    expect(runCli(['config', 'list-env', '-a', 'myagent'], { cwd: workDir, env }).status).toBe(0);
    expect(
      runCli(['config', 'remove-env', 'MY_VAR', '-a', 'myagent'], {
        cwd: workDir,
        env,
      }).status,
    ).toBe(0);
    expect(await readText(configPath)).not.toContain('MY_VAR');
  });

  it.skipIf(!CLI_READY)('config set-default / remove work', async () => {
    addAgent('a1');
    addAgent('a2');

    expect(runCli(['config', 'set-default', 'a2'], { cwd: workDir, env }).status).toBe(0);
    expect(runCli(['config', 'remove', 'a1'], { cwd: workDir, env }).status).toBe(0);

    const remaining = await readText(join(workDir, '.agentarts_config.yaml'));
    expect(remaining).toContain('a2');
    expect(remaining).not.toContain('a1');
  });

  // -------------------------------------------------------------------------
  // dev (blocking HTTP server — subprocess)
  // -------------------------------------------------------------------------

  it.skipIf(!CLI_READY)('dev serves /ping and /invocations', { timeout: 120_000 }, async () => {
    // Scaffold a minimal Node project in workDir.
    //
    // Python's test reuses the `init` scaffold because the Python CLI starts a
    // uvicorn app; in the Node port `init` emits a *deployable Python*
    // project, while `dev` loads a TS/JS entrypoint. The minimal project below
    // is the Node equivalent of that scaffold (runtime app + config).
    const project = join(workDir, 'myagent');
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, '.agentarts_config.yaml'),
      [
        'default_agent: myagent',
        'agents:',
        '  myagent:',
        '    base:',
        '      name: myagent',
        '      entrypoint: agent:app',
        '',
      ].join('\n'),
    );
    const sdkIndexUrl = pathToFileURL(join(dirname(CLI_DIST_PATH), 'index.js')).href;
    await writeFile(
      join(project, 'agent.mjs'),
      [
        `import { AgentArtsRuntimeApp } from '${sdkIndexUrl}';`,
        'const app = new AgentArtsRuntimeApp();',
        'app.entrypoint((payload) => ({ response: payload }));',
        'export { app };',
        '',
      ].join('\n'),
    );

    // 2. Launch `agentarts dev` against it.
    const port = await findFreePort();
    const cli = spawnCli(['dev', '-p', String(port), '-h', '127.0.0.1'], {
      cwd: project,
      env,
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      let pingOk = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(1000) });
          if (response.status === 200) {
            pingOk = true;
            break;
          }
        } catch {
          // server not up yet
        }
        await sleep(500);
      }
      expect(pingOk, `dev server did not come up:\n${cli.readStdout()}${cli.readStderr()}`).toBe(
        true,
      );

      // 3. POST /invocations.
      const response = await fetch(`${base}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect('response' in body).toBe(true);
    } finally {
      cli.child.kill();
      await Promise.race([once(cli.child, 'exit'), sleep(5_000)]);
      if (cli.child.exitCode === null) {
        cli.child.kill('SIGKILL');
      }
      await cli.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Local filesystem helpers
// ---------------------------------------------------------------------------

function exists(path: string): boolean {
  return existsSync(path);
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
