/**
 * High-level client for Huawei Cloud Agent Identity.
 */

import { randomUUID } from 'node:crypto';
import { Region } from '@huaweicloud/huaweicloud-sdk-core';
import { ServiceResponseException } from '@huaweicloud/huaweicloud-sdk-core/exception/ServiceResponseException.js';
import {
  AgentIdentityClient,
  ApiKeyCredentialProvider,
  ApiKeyCredentialProviderSummary,
  AuthorizerType,
  CompleteResourceTokenAuthRequest,
  CompleteResourceTokenAuthRequestBody,
  CompleteResourceTokenAuthResponse,
  CreateApiKeyCredentialProviderReqBody,
  CreateApiKeyCredentialProviderRequest,
  CreateApiKeyCredentialProviderResponse,
  CreateOauth2CredentialProviderReqBody,
  CreateOauth2CredentialProviderRequest,
  CreateOauth2CredentialProviderResponse,
  CreateStsCredentialProviderReqBody,
  CreateStsCredentialProviderRequest,
  CreateStsCredentialProviderResponse,
  CreateWorkloadAccessTokenForJwtRequest,
  CreateWorkloadAccessTokenForJwtRequestBody,
  CreateWorkloadAccessTokenForJwtResponse,
  CreateWorkloadAccessTokenForUserIdRequest,
  CreateWorkloadAccessTokenForUserIdRequestBody,
  CreateWorkloadAccessTokenForUserIdResponse,
  CreateWorkloadAccessTokenRequest,
  CreateWorkloadAccessTokenRequestBody,
  CreateWorkloadAccessTokenResponse,
  CreateWorkloadIdentityReqBody,
  CreateWorkloadIdentityRequest,
  CreateWorkloadIdentityResponse,
  CustomOauth2ProviderConfigInput,
  GetApiKeyCredentialProviderRequest,
  GetApiKeyCredentialProviderResponse,
  GetOauth2CredentialProviderRequest,
  GetOauth2CredentialProviderResponse,
  GetResourceApiKeyRequest,
  GetResourceApiKeyRequestBody,
  GetResourceApiKeyResponse,
  GetResourceOauth2TokenRequest,
  GetResourceOauth2TokenRequestBody,
  GetResourceOauth2TokenResponse,
  GetResourceStsTokenRequest,
  GetResourceStsTokenRequestBody,
  GetResourceStsTokenResponse,
  GetStsCredentialProviderRequest,
  GetStsCredentialProviderResponse,
  GetWorkloadIdentityRequest,
  GetWorkloadIdentityResponse,
  GithubOauth2ProviderConfigInput,
  GoogleOauth2ProviderConfigInput,
  ListApiKeyCredentialProvidersRequest,
  ListApiKeyCredentialProvidersResponse,
  ListOauth2CredentialProvidersRequest,
  ListOauth2CredentialProvidersResponse,
  ListStsCredentialProvidersRequest,
  ListStsCredentialProvidersResponse,
  ListWorkloadIdentitiesRequest,
  ListWorkloadIdentitiesResponse,
  MicrosoftOauth2ProviderConfigInput,
  Oauth2CredentialProvider,
  Oauth2CredentialProviderSummary,
  Oauth2ProviderConfigInput,
  StsCredentialProvider,
  StsCredentialProviderSummary,
  StsTag,
  Tag,
  UpdateWorkloadIdentityReqBody,
  UpdateWorkloadIdentityRequest,
  UpdateWorkloadIdentityResponse,
  UserIdentifier,
  WorkloadIdentity,
  WorkloadIdentitySummary,
} from '@huaweicloud/huaweicloud-sdk-agentidentity';

import { getIdentityEndpoint } from '../../utils/constant.js';
import { getLogger } from '../../utils/logging.js';
import { createCredential } from '../../utils/metadata.js';
import { buildUserAgent } from '../../utils/user-agent.js';
import { buildSslRequestOptions } from '../../utils/http-options.js';
import { OAuth2Vendor, type OAuth2Discovery, type StsCredentials } from '../../identity/types.js';
import {
  DefaultApiTokenPoller,
  PollingResult,
  PollingStatus,
  TokenPoller,
} from './polling/token-poller.js';

/** Retry configuration understood by the generated invokers. */
export interface RetryOptions {
  retryCondition?: (response?: any, exception?: any) => boolean;
  maxRetries?: number;
  backoffStrategy?: 'EQUAL_JITTER' | 'EXPONENTIAL';
}

/** Retryable operation returned by the generated `*Invoker` methods. */
export interface Invoker<T> {
  withRetry(options?: RetryOptions): Invoker<T>;
  invoke(): Promise<T>;
}

export interface GetResourceOauth2TokenOptions {
  providerName: string;
  workloadAccessToken: string;
  authFlow: 'M2M' | 'USER_FEDERATION';
  scopes?: string[] | null;
  onAuthUrl?: ((url: string) => any) | null;
  callbackUrl?: string | null;
  forceAuthentication?: boolean;
  tokenPoller?: TokenPoller | null;
  customState?: string | null;
  customParameters?: Record<string, string> | null;
}

export interface GetResourceApiKeyOptions {
  providerName: string;
  workloadAccessToken: string;
}

export interface GetResourceStsTokenOptions {
  providerName: string;
  workloadAccessToken: string;
  agencySessionName: string;
  durationSeconds?: number | null;
  policy?: string | null;
  sourceIdentity?: string | null;
  tags?: StsTag[] | null;
  transitiveTagKeys?: string[] | null;
}

export class IdentityClient {
  readonly region: string;
  private readonly logger = getLogger('identity_client');
  private readonly _ignoreSslVerification: boolean;
  private _client?: AgentIdentityClient;

  /**
   * @param region The region name (e.g. 'ap-southeast-4').
   * @param ignoreSslVerification Whether to ignore SSL verification.
   * @param client Optional AgentIdentityClient instance to inject.
   */
  constructor(region: string, ignoreSslVerification?: boolean | null, client?: AgentIdentityClient) {
    this.region = region;
    this._ignoreSslVerification = ignoreSslVerification ?? false;
    this._client = client;
    this.logger.info(`Initialized Huawei Cloud Agent Identity client for region: ${region}`);
  }

  private async _ensureClient(): Promise<AgentIdentityClient> {
    if (this._client) {
      return this._client;
    }
    this._client = AgentIdentityClient.newBuilder()
      .withRegion(new Region(this.region, getIdentityEndpoint(this.region)))
      .withOptions({
        customUserAgent: buildUserAgent(),
        ...buildSslRequestOptions(!this._ignoreSslVerification),
      })
      .withCredential(await createCredential())
      .build();
    return this._client;
  }

  /**
   * Determine whether a request should be retried.
   *
   * Retries on throttling (429), server errors (5xx) and network issues.
   */
  static _shouldRetry(response?: any, exception?: any): boolean {
    if (exception) {
      if (exception instanceof ServiceResponseException) {
        const statusCode = Number(exception.httpStatusCode);
        return statusCode === 429 || statusCode >= 500;
      }
      return true;
    }

    if (response) {
      const statusCode = response.httpStatusCode ?? response.statusCode;
      return statusCode !== undefined && statusCode !== null && (statusCode === 429 || statusCode >= 500);
    }

    return false;
  }

  private static _retryCondition = (response?: any, exception?: any): boolean =>
    IdentityClient._shouldRetry(response, exception);

  private static _retryOptions(): RetryOptions {
    return {
      retryCondition: IdentityClient._retryCondition,
      maxRetries: 3,
      backoffStrategy: 'EQUAL_JITTER',
    };
  }

  /** Create a workload identity with an optional name. */
  async createWorkloadIdentity(
    name?: string | null,
    allowedResourceOauth2ReturnUrls?: string[] | null,
    authorizerType: string | AuthorizerType = AuthorizerType.NONE,
    authorizerConfiguration?: any,
  ): Promise<WorkloadIdentity> {
    const client = await this._ensureClient();
    this.logger.info('Creating workload identity...');
    const workloadName = name || `workload-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const response: CreateWorkloadIdentityResponse = await client.createWorkloadIdentity(
      new CreateWorkloadIdentityRequest({
        body: new CreateWorkloadIdentityReqBody({
          name: workloadName,
          allowedResourceOauth2ReturnUrls: allowedResourceOauth2ReturnUrls || [],
          authorizerType: authorizerType as any,
          authorizerConfiguration,
        }),
      }),
    );

    return response.workloadIdentity as WorkloadIdentity;
  }

  /** Update an existing workload identity configuration. */
  async updateWorkloadIdentity(
    name: string,
    allowedResourceOauth2ReturnUrls?: string[] | null,
    authorizerConfiguration?: any,
  ): Promise<WorkloadIdentity> {
    const client = await this._ensureClient();
    this.logger.info(`Updating workload identity: ${name}`);

    const response: UpdateWorkloadIdentityResponse = await client.updateWorkloadIdentity(
      new UpdateWorkloadIdentityRequest({
        workloadIdentityName: name,
        body: new UpdateWorkloadIdentityReqBody({
          allowedResourceOauth2ReturnUrls: allowedResourceOauth2ReturnUrls ?? undefined,
          authorizerConfiguration,
        }),
      }),
    );
    return response.workloadIdentity as WorkloadIdentity;
  }

  /** Get a specified workload identity. */
  async getWorkloadIdentity(name: string): Promise<WorkloadIdentity> {
    const client = await this._ensureClient();
    this.logger.info(`Getting workload identity: ${name}`);

    const response: GetWorkloadIdentityResponse = await client.getWorkloadIdentity(
      new GetWorkloadIdentityRequest({ workloadIdentityName: name }),
    );
    return response.workloadIdentity as WorkloadIdentity;
  }

  /** List all workload identities. */
  async listWorkloadIdentities(
    limit?: number | null,
    marker?: string | null,
  ): Promise<WorkloadIdentitySummary[]> {
    const client = await this._ensureClient();
    this.logger.info('Listing workload identities...');

    const response: ListWorkloadIdentitiesResponse = await client.listWorkloadIdentities(
      new ListWorkloadIdentitiesRequest({ limit: limit ?? undefined, marker: marker ?? undefined }),
    );
    return (response.workloadIdentities ?? []) as WorkloadIdentitySummary[];
  }

  /** Create a new API key credential provider. */
  async createApiKeyCredentialProvider(
    name: string,
    apiKey: string,
  ): Promise<ApiKeyCredentialProvider> {
    const client = await this._ensureClient();
    this.logger.info(`Creating API key credential provider: ${name}`);

    const response: CreateApiKeyCredentialProviderResponse =
      await client.createApiKeyCredentialProvider(
        new CreateApiKeyCredentialProviderRequest({
          body: new CreateApiKeyCredentialProviderReqBody({ name, apiKey }),
        }),
      );
    return response.credentialProvider as ApiKeyCredentialProvider;
  }

  /** Create a new OAuth2 credential provider. */
  async createOauth2CredentialProvider(
    name: string,
    vendor: OAuth2Vendor,
    clientId: string,
    clientSecret: string,
    tenantId?: string | null,
    oauthDiscovery?: OAuth2Discovery | null,
    tags?: Tag[] | null,
  ): Promise<Oauth2CredentialProvider> {
    const client = await this._ensureClient();
    this.logger.info(`Creating OAuth2 credential provider: ${name}`);

    let config: Oauth2ProviderConfigInput;
    if (vendor === OAuth2Vendor.GITHUBOAUTH2) {
      config = new Oauth2ProviderConfigInput({
        githubOauth2ProviderConfig: new GithubOauth2ProviderConfigInput({ clientId, clientSecret }),
      });
    } else if (vendor === OAuth2Vendor.GOOGLEOAUTH2) {
      config = new Oauth2ProviderConfigInput({
        googleOauth2ProviderConfig: new GoogleOauth2ProviderConfigInput({ clientId, clientSecret }),
      });
    } else if (vendor === OAuth2Vendor.MICROSOFTOAUTH2) {
      config = new Oauth2ProviderConfigInput({
        microsoftOauth2ProviderConfig: new MicrosoftOauth2ProviderConfigInput({
          tenantId: tenantId ?? undefined,
          clientId,
          clientSecret,
        }),
      });
    } else if (vendor === OAuth2Vendor.CUSTOMOAUTH2) {
      config = new Oauth2ProviderConfigInput({
        customOauth2ProviderConfig: new CustomOauth2ProviderConfigInput({
          oauth2Discovery: oauthDiscovery ?? undefined,
          clientId,
          clientSecret,
        }),
      });
    } else {
      throw new Error(`Unsupported vendor: ${vendor}`);
    }

    const response: CreateOauth2CredentialProviderResponse =
      await client.createOauth2CredentialProvider(
        new CreateOauth2CredentialProviderRequest({
          body: new CreateOauth2CredentialProviderReqBody({
            name,
            credentialProviderVendor: vendor as any,
            oauth2ProviderConfigInput: config,
            tags: tags ?? undefined,
          }),
        }),
      );
    return response.credentialProvider as Oauth2CredentialProvider;
  }

  /** Create a new STS credential provider. */
  async createStsCredentialProvider(
    name: string,
    agencyUrn: string,
    tags?: Tag[] | null,
  ): Promise<StsCredentialProvider> {
    const client = await this._ensureClient();
    this.logger.info(`Creating STS credential provider: ${name}`);

    const response: CreateStsCredentialProviderResponse =
      await client.createStsCredentialProvider(
        new CreateStsCredentialProviderRequest({
          body: new CreateStsCredentialProviderReqBody({
            name,
            agencyUrn,
            tags: tags ?? undefined,
          }),
        }),
      );
    return response.credentialProvider as StsCredentialProvider;
  }

  /** Get a workload access token using a workload name and optionally a user token. */
  async createWorkloadAccessToken(
    workloadName: string,
    userToken?: string | null,
    userId?: string | null,
  ): Promise<string> {
    const client = await this._ensureClient();
    let response: CreateWorkloadAccessTokenResponse | CreateWorkloadAccessTokenForJwtResponse | CreateWorkloadAccessTokenForUserIdResponse;

    if (userToken) {
      if (userId !== undefined && userId !== null) {
        this.logger.warning('Both user token and user id are supplied, using user token');
      }
      this.logger.info('Getting workload access token for JWT...');
      response = await client
        .createWorkloadAccessTokenForJwtInvoker(
          new CreateWorkloadAccessTokenForJwtRequest({
            body: new CreateWorkloadAccessTokenForJwtRequestBody({
              workloadName,
              userToken,
            }),
          }),
        )
        .withRetry(IdentityClient._retryOptions())
        .invoke();
    } else if (userId) {
      this.logger.info('Getting workload access token for user id...');
      response = await client
        .createWorkloadAccessTokenForUserIdInvoker(
          new CreateWorkloadAccessTokenForUserIdRequest({
            body: new CreateWorkloadAccessTokenForUserIdRequestBody({
              workloadName,
              userId,
            }),
          }),
        )
        .withRetry(IdentityClient._retryOptions())
        .invoke();
    } else {
      this.logger.info('Getting workload access token...');
      response = await client
        .createWorkloadAccessTokenInvoker(
          new CreateWorkloadAccessTokenRequest({
            body: new CreateWorkloadAccessTokenRequestBody({ workloadName }),
          }),
        )
        .withRetry(IdentityClient._retryOptions())
        .invoke();
    }

    this.logger.info('Successfully retrieved workload access token');
    return response.workloadAccessToken as string;
  }

  /** Get a specified API key credential provider. */
  async getApiKeyCredentialProvider(name: string): Promise<ApiKeyCredentialProvider> {
    const client = await this._ensureClient();
    this.logger.info(`Getting API key credential provider: ${name}`);

    const response: GetApiKeyCredentialProviderResponse =
      await client.getApiKeyCredentialProvider(
        new GetApiKeyCredentialProviderRequest({ credentialProviderName: name }),
      );
    return response.credentialProvider as ApiKeyCredentialProvider;
  }

  /** List all API key credential providers. */
  async listApiKeyCredentialProviders(
    limit?: number | null,
    marker?: string | null,
  ): Promise<ApiKeyCredentialProviderSummary[]> {
    const client = await this._ensureClient();
    this.logger.info('Listing API key credential providers...');

    const response: ListApiKeyCredentialProvidersResponse =
      await client.listApiKeyCredentialProviders(
        new ListApiKeyCredentialProvidersRequest({ limit: limit ?? undefined, marker: marker ?? undefined }),
      );
    return (response.credentialProviders ?? []) as ApiKeyCredentialProviderSummary[];
  }

  /** Get a specified OAuth2 credential provider. */
  async getOauth2CredentialProvider(name: string): Promise<Oauth2CredentialProvider> {
    const client = await this._ensureClient();
    this.logger.info(`Getting OAuth2 credential provider: ${name}`);

    const response: GetOauth2CredentialProviderResponse =
      await client.getOauth2CredentialProvider(
        new GetOauth2CredentialProviderRequest({ credentialProviderName: name }),
      );
    return response.credentialProvider as Oauth2CredentialProvider;
  }

  /** List all OAuth2 credential providers. */
  async listOauth2CredentialProviders(
    limit?: number | null,
    marker?: string | null,
  ): Promise<Oauth2CredentialProviderSummary[]> {
    const client = await this._ensureClient();
    this.logger.info('Listing OAuth2 credential providers...');

    const response: ListOauth2CredentialProvidersResponse =
      await client.listOauth2CredentialProviders(
        new ListOauth2CredentialProvidersRequest({ limit: limit ?? undefined, marker: marker ?? undefined }),
      );
    return (response.credentialProviders ?? []) as Oauth2CredentialProviderSummary[];
  }

  /** Get a specified STS credential provider. */
  async getStsCredentialProvider(name: string): Promise<StsCredentialProvider> {
    const client = await this._ensureClient();
    this.logger.info(`Getting STS credential provider: ${name}`);

    const response: GetStsCredentialProviderResponse = await client.getStsCredentialProvider(
      new GetStsCredentialProviderRequest({ credentialProviderName: name }),
    );
    return response.credentialProvider as StsCredentialProvider;
  }

  /** List all STS credential providers. */
  async listStsCredentialProviders(
    limit?: number | null,
    marker?: string | null,
  ): Promise<StsCredentialProviderSummary[]> {
    const client = await this._ensureClient();
    this.logger.info('Listing STS credential providers...');

    const response: ListStsCredentialProvidersResponse = await client.listStsCredentialProviders(
      new ListStsCredentialProvidersRequest({ limit: limit ?? undefined, marker: marker ?? undefined }),
    );
    return (response.credentialProviders ?? []) as StsCredentialProviderSummary[];
  }

  /**
   * Get an OAuth2 access token for the specified provider.
   */
  async getResourceOauth2Token(options: GetResourceOauth2TokenOptions): Promise<string> {
    const client = await this._ensureClient();
    this.logger.info('Getting OAuth2 token...');

    const {
      providerName,
      workloadAccessToken,
      authFlow,
      scopes = null,
      onAuthUrl = null,
      callbackUrl = null,
      forceAuthentication = false,
      tokenPoller = null,
      customState = null,
      customParameters = null,
    } = options;

    const getToken = async (
      currentSessionUri?: string | null,
      isPolling = false,
    ): Promise<GetResourceOauth2TokenResponse> => {
      // force_authentication should only be true on the initial call.
      const effectiveForceAuth = isPolling ? false : forceAuthentication;
      return client.getResourceOauth2Token(
        new GetResourceOauth2TokenRequest({
          body: new GetResourceOauth2TokenRequestBody({
            resourceCredentialProviderName: providerName,
            workloadAccessToken,
            oauth2Flow: authFlow,
            scopes: scopes ?? undefined,
            resourceOauth2ReturnUrl: callbackUrl ?? undefined,
            forceAuthentication: effectiveForceAuth,
            customState: customState ?? undefined,
            customParameters: customParameters ?? undefined,
            sessionUri: currentSessionUri ?? undefined,
          }),
        }),
      );
    };

    const response = await getToken();

    if (response.accessToken) {
      this.logger.info('Successfully retrieved OAuth2 token directly.');
      return response.accessToken;
    }

    if (response.authorizationUrl) {
      const authUrl = response.authorizationUrl;
      const sessionUri = response.sessionUri;

      this.logger.info(`User consent required. Auth URL: ${authUrl}`);

      if (onAuthUrl) {
        await Promise.resolve(onAuthUrl(authUrl));
      }

      const pollFn = async (): Promise<PollingResult> => {
        const resp = await getToken(sessionUri, true);
        if (resp.accessToken) {
          return new PollingResult({ accessToken: resp.accessToken });
        }
        if (resp.sessionStatus === PollingStatus.FAILED) {
          return new PollingResult({ status: PollingStatus.FAILED });
        }
        return new PollingResult({ status: PollingStatus.IN_PROGRESS });
      };

      const activePoller = tokenPoller ?? new DefaultApiTokenPoller(authUrl, pollFn);
      return activePoller.pollForToken();
    }

    throw new Error('Identity service did not return a token or an authorization URL.');
  }

  /** Programmatically retrieve an API key from the Identity service. */
  async getResourceApiKey(options: GetResourceApiKeyOptions): Promise<string> {
    const client = await this._ensureClient();
    this.logger.info('Getting API key...');

    const response: GetResourceApiKeyResponse = await client
      .getResourceApiKeyInvoker(
        new GetResourceApiKeyRequest({
          body: new GetResourceApiKeyRequestBody({
            resourceCredentialProviderName: options.providerName,
            workloadAccessToken: options.workloadAccessToken,
          }),
        }),
      )
      .withRetry(IdentityClient._retryOptions())
      .invoke();

    return response.apiKey as string;
  }

  /** Get an STS token from the Identity service. */
  async getResourceStsToken(options: GetResourceStsTokenOptions): Promise<StsCredentials> {
    const client = await this._ensureClient();
    this.logger.info('Getting STS token...');

    const response: GetResourceStsTokenResponse = await client
      .getResourceStsTokenInvoker(
        new GetResourceStsTokenRequest({
          body: new GetResourceStsTokenRequestBody({
            resourceCredentialProviderName: options.providerName,
            workloadAccessToken: options.workloadAccessToken,
            agencySessionName: options.agencySessionName,
            durationSeconds: options.durationSeconds ?? undefined,
            policy: options.policy ?? undefined,
            sourceIdentity: options.sourceIdentity ?? undefined,
            tags: options.tags ?? undefined,
            transitiveTagKeys: options.transitiveTagKeys ?? undefined,
          }),
        }),
      )
      .withRetry(IdentityClient._retryOptions())
      .invoke();

    return response.credentials as StsCredentials;
  }

  /** Confirm the user authentication session for obtaining OAuth2.0 tokens. */
  async completeResourceTokenAuth(
    sessionUri: string,
    userIdentifier: UserIdentifier,
  ): Promise<CompleteResourceTokenAuthResponse> {
    const client = await this._ensureClient();
    this.logger.info('Completing 3LO OAuth2 flow...');

    return client.completeResourceTokenAuth(
      new CompleteResourceTokenAuthRequest({
        body: new CompleteResourceTokenAuthRequestBody({ userIdentifier, sessionUri }),
      }),
    );
  }
}




