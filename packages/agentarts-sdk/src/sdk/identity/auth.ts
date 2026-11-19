/**
 * Authentication helper factories.
 *
 * Python uses decorators to inject access tokens, API keys and STS
 * credentials. TypeScript has no keyword-argument injection, so these helpers
 * are factories returning a wrapper that appends the injected value as the
 * final positional argument.
 */

import { randomUUID } from 'node:crypto';

import { AgentArtsRuntimeContext } from '../runtime/context.js';
import { getRegion } from '../utils/constant.js';
import { getLogger } from '../utils/logging.js';
import { Config } from './config.js';
import { IdentityClient } from '../service/identity/identity-client.js';
import { TokenPoller } from '../service/identity/polling/token-poller.js';
import type { StsCredentials, OAuth2Vendor } from './types.js';
import type { StsTag } from '@huaweicloud/huaweicloud-sdk-agentidentity';

const logger = getLogger('identity.auth');

export interface RequireAccessTokenOptions {
  providerName: string;
  into?: string;
  scopes?: string[] | null;
  onAuthUrl?: ((url: string) => any) | null;
  authFlow: 'M2M' | 'USER_FEDERATION';
  callbackUrl?: string | null;
  forceAuthentication?: boolean;
  tokenPoller?: TokenPoller | null;
  customState?: string | null;
  customParameters?: Record<string, string> | null;
  ignoreSslVerification?: boolean | null;
}

export function requireAccessToken(options: RequireAccessTokenOptions) {
  const {
    providerName,
    scopes = null,
    onAuthUrl = null,
    authFlow,
    callbackUrl = null,
    forceAuthentication = false,
    tokenPoller = null,
    customState = null,
    customParameters = null,
    ignoreSslVerification = null,
  } = options;

  return function decorator<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => Promise<any> {
    return async (...args: Parameters<F>): Promise<any> => {
      const client = new IdentityClient(getRegion(), ignoreSslVerification);
      const token = await getResourceOauth2Token(client, {
        providerName,
        workloadAccessToken: await getWorkloadAccessToken(client),
        scopes,
        onAuthUrl,
        authFlow,
        callbackUrl: getOauth2CallbackUrl(callbackUrl),
        forceAuthentication,
        tokenPoller,
        customState: getOauth2CustomState(customState),
        customParameters,
      });
      return (fn as any)(...args, token);
    };
  };

  async function getResourceOauth2Token(
    client: IdentityClient,
    params: Parameters<IdentityClient['getResourceOauth2Token']>[0],
  ): Promise<string> {
    return client.getResourceOauth2Token(params);
  }
}

export interface RequireApiKeyOptions {
  providerName: string;
  into?: string;
  ignoreSslVerification?: boolean | null;
}

export function requireApiKey(options: RequireApiKeyOptions) {
  const { providerName, ignoreSslVerification = null } = options;

  return function decorator<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => Promise<any> {
    return async (...args: Parameters<F>): Promise<any> => {
      const client = new IdentityClient(getRegion(), ignoreSslVerification);
      const apiKey = await client.getResourceApiKey({
        providerName,
        workloadAccessToken: await getWorkloadAccessToken(client),
      });
      return (fn as any)(...args, apiKey);
    };
  };
}

export interface RequireStsTokenOptions {
  providerName: string;
  agencySessionName: string;
  durationSeconds?: number | null;
  policy?: string | null;
  sourceIdentity?: string | null;
  tags?: StsTag[] | null;
  transitiveTagKeys?: string[] | null;
  into?: string;
  ignoreSslVerification?: boolean | null;
}

export function requireStsToken(options: RequireStsTokenOptions) {
  const { providerName, agencySessionName, ignoreSslVerification = null } = options;

  return function decorator<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => Promise<any> {
    return async (...args: Parameters<F>): Promise<any> => {
      const client = new IdentityClient(getRegion(), ignoreSslVerification);
      const sts = await client.getResourceStsToken({
        providerName,
        workloadAccessToken: await getWorkloadAccessToken(client),
        agencySessionName,
        durationSeconds: options.durationSeconds ?? null,
        policy: options.policy ?? null,
        sourceIdentity: options.sourceIdentity ?? null,
        tags: options.tags ?? null,
        transitiveTagKeys: options.transitiveTagKeys ?? null,
      });
      return (fn as any)(...args, sts);
    };
  };
}

/** Resolve the workload access token from context, falling back to local auth. */
export async function getWorkloadAccessToken(client: IdentityClient): Promise<string> {
  const token = AgentArtsRuntimeContext.getWorkloadAccessToken();
  if (token !== null && token !== undefined) {
    logger.info('Retrieved workload access token from context');
    return token;
  }
  logger.info(
    'No workload access token found in context. Falling back to local authentication setup.',
  );
  return setUpLocalAuth(client);
}

function getOauth2CallbackUrl(userProvidedOauth2CallbackUrl?: string | null): string | null {
  if (userProvidedOauth2CallbackUrl) {
    return userProvidedOauth2CallbackUrl;
  }
  return AgentArtsRuntimeContext.getOauth2CallbackUrl();
}

function getOauth2CustomState(userProvidedCustomState?: string | null): string | null {
  if (userProvidedCustomState) {
    return userProvidedCustomState;
  }
  return AgentArtsRuntimeContext.getOauth2CustomState();
}

/** Ensure a workload identity and user id exist locally, then fetch a token. */
export async function setUpLocalAuth(client: IdentityClient): Promise<string> {
  const config = Config.load();

  let workloadIdentityName = config.workloadIdentityName;
  if (workloadIdentityName) {
    logger.info(
      `Found existing workload identity from ${config.path}: ${workloadIdentityName}`,
    );
  } else {
    const workloadIdentity = await client.createWorkloadIdentity();
    logger.info('Created a workload identity');
    workloadIdentityName = workloadIdentity.name as string;
    config.workloadIdentityName = workloadIdentity.name ?? null;
    config.save();
  }

  let userId = AgentArtsRuntimeContext.getUserId();
  if (userId) {
    logger.info(`Using user id from context: ${userId}`);
  } else {
    userId = config.userId;
    if (userId) {
      logger.info(`Found existing user id from ${config.path}: ${userId}`);
    } else {
      userId = randomUUID().replace(/-/g, '').slice(0, 8);
      logger.info('Created an user id');
      config.userId = userId;
      config.save();
    }
  }

  return client.createWorkloadAccessToken(workloadIdentityName, undefined, userId);
}
