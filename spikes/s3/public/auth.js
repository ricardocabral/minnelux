import {
  CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signIn(config) {
  const popup = window.open('about:blank', '_blank', 'popup');
  if (!popup) throw new Error('Allow the Cognito sign-in popup and try again.');
  popup.opener = null;
  const redirect = new URL('./callback.html', location.href).href;
  const state = randomHex();
  const verifier = randomHex();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const authorize = new URL('/oauth2/authorize', config.cognitoOrigin);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: redirect,
    scope: 'openid', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login',
  });
  const callback = new BroadcastChannel(`minnelux-s3-${state}`);
  try {
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Cognito sign-in timed out.')), 180_000);
      callback.onmessage = ({ data }) => {
        clearTimeout(timeout);
        if (data?.error || typeof data?.code !== 'string' || !data.code) {
          reject(new Error('Cognito sign-in did not return an authorization code.'));
        } else {
          resolve(data.code);
        }
      };
      popup.location.replace(authorize.href);
    });
    const result = await fetch(new URL('/oauth2/token', config.cognitoOrigin), {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: config.clientId,
        code, redirect_uri: redirect, code_verifier: verifier,
      }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!result.ok) throw new Error(`Cognito token exchange returned HTTP ${result.status}.`);
    const { id_token: idToken } = await result.json();
    if (typeof idToken !== 'string') throw new Error('Cognito did not return an ID token.');

    const identity = new CognitoIdentityClient({ region: config.region });
    const logins = { [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: idToken };
    const { IdentityId } = await identity.send(new GetIdCommand({
      IdentityPoolId: config.identityPoolId, Logins: logins,
    }));
    const { Credentials } = await identity.send(new GetCredentialsForIdentityCommand({
      IdentityId, Logins: logins,
    }));
    if (!Credentials?.AccessKeyId || !Credentials.SecretKey || !Credentials.SessionToken ||
        !(Credentials.Expiration?.getTime() > Date.now())) {
      throw new Error('Cognito did not return valid temporary AWS credentials.');
    }
    return {
      identityId: IdentityId,
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretKey,
        sessionToken: Credentials.SessionToken,
        expiration: Credentials.Expiration,
      },
    };
  } finally {
    callback.close();
    popup.close();
  }
}
