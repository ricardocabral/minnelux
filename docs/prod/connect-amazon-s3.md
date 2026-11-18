# Connect a private Amazon S3 library

Use the self-hosted static web build to connect through Cognito. Use the optional session server for Google libraries. [Static web build instructions](../../apps/web/README.md#self-host-the-web-client)

## Set up the bucket and sign-in

1. [Deploy the web client](../../apps/web/README.md#self-host-the-web-client) on HTTPS. Create a private general-purpose S3 bucket, enable all Block Public Access settings, and choose a library prefix. Use a test bucket and synthetic photos for the first connection. [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
2. In the bucket region, set up a Cognito user pool with an AWS-provided managed-login domain and a public app client without a secret. Enable the authorization code grant and the `openid` scope. Register the exact callback URL, including any app subpath, such as `https://photos.example.com/web/cognito-callback.html`. For local development, use `http://localhost:5173/cognito-callback.html` if Vite uses port 5173. Provision the users who need access. [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
3. Register the app client with a Cognito identity pool in the same region and disable unauthenticated access. Map users or groups to viewer and editor IAM roles. Put editors in the group entered in the app, which defaults to `writers`. Trust only the intended pool and authenticated identities. Deny unmapped identities or assign them a role with zero S3 permissions. [Cognito role mapping](https://docs.aws.amazon.com/cognito/latest/developerguide/role-based-access-control.html)
4. Scope `s3:ListBucket` to the library prefix and `s3:GetObject` to its keys. Editors also need conditional `s3:PutObject`. Require `If-None-Match: *` for immutable objects. Allow `If-None-Match: *` to create `head.json` and `If-Match` to replace it. Keep delete and recovery privileges with administrative roles. [S3 policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html) · [Enforce conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)

## Configure browser access

Set bucket CORS to the exact app origin. Allow `GET`, `HEAD`, and `PUT`, with request headers `Authorization`, `Content-Type`, `Range`, `If-Match`, `If-None-Match`, `x-amz-*`, `amz-sdk-invocation-id`, and `amz-sdk-request`. Expose `ETag`, `Content-Range`, and `Accept-Ranges`. [S3 CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)

In the app page’s `connect-src` policy, allow the managed-login origin and `https://cognito-identity.<region>.amazonaws.com`. In the worker’s policy, allow the regional S3 origin the SDK uses for your bucket, typically `https://<bucket>.s3.<region>.amazonaws.com`.

## Open the library

Under **Storage provider**, choose **Amazon S3** and enter the bucket name, AWS region, library prefix (default `library`), Cognito managed-login origin, public app client ID, user pool ID, and identity pool ID. Enter an editor group if you use a group other than `writers`. Connect and sign in as a Cognito library user.

As an editor, publish a synthetic JPEG and reopen the library. As a viewer, confirm that the photo opens and the app offers no import action.

## If the library fails to open

| Symptom | Check |
| --- | --- |
| Cognito sign-in fails | Check the managed-login origin, app client, callback URL, and user status. |
| Sign-in works but the library is denied | Check the identity pool role mapping, bucket region, and role permissions for the prefix. |
| Browsing works but changes fail | Check the Cognito editor group and the IAM role's conditional write permissions. |
| The browser reports a network or cross-origin error | Check the regional endpoints, app origin, CORS headers, and Content Security Policy. |

**Disconnect** clears the local app session. To remove someone's access, remove their role assignment and revoke their Cognito sessions. IAM can revoke already-issued AWS sessions for a role. That revocation affects other sessions using the role. [Revoke IAM role sessions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html)
