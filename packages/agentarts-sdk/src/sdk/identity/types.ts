/**
 * Type aliases for improved developer experience.
 *
 * Provides user-friendly type aliases for types used throughout the SDK.
 */

import {
  CredentialProviderVendor,
  type GetResourceStsTokenResponseBodyCredentials,
  type Oauth2Discovery as Oauth2DiscoveryModel,
} from '@tianma630/huaweicloud-sdk-agentidentity';

/**
 * Type alias for STS token credentials.
 *
 * Injected by `requireStsToken` into your function.
 *
 * Attributes:
 * - `accessKeyId`: the access key ID for authentication
 * - `secretAccessKey`: the secret access key for authentication
 * - `securityToken`: the temporary security token
 * - `expiration`: the expiration time of the credentials
 */
export type StsCredentials = GetResourceStsTokenResponseBodyCredentials;

/** Type alias for the OAuth2 discovery configuration. */
export type OAuth2Discovery = Oauth2DiscoveryModel;

/** OAuth2 credential provider vendors. */
export enum OAuth2Vendor {
  GITHUBOAUTH2 = CredentialProviderVendor.GITHUBOAUTH2,
  GOOGLEOAUTH2 = CredentialProviderVendor.GOOGLEOAUTH2,
  MICROSOFTOAUTH2 = CredentialProviderVendor.MICROSOFTOAUTH2,
  CUSTOMOAUTH2 = CredentialProviderVendor.CUSTOMOAUTH2,
}
