# Connect a private Amazon S3 library

Use a private test bucket and synthetic photos to try the Amazon S3 photo workflow. The bucket owner configures AWS once. Library users sign in through Amazon Cognito with the identities the owner grants access to.

## Set up the bucket and sign-in

1. Deploy Minnelux on a dedicated HTTPS origin. Create a private general-purpose S3 bucket in your chosen region, enable all S3 Block Public Access settings, and choose the library prefix. Grant read access to any separate prefix containing existing media. [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
2. Set up a Cognito user pool with managed login and a public app client without a client secret. Enable the authorization code grant and the `openid` scope. Minnelux uses PKCE for this flow. Use the AWS-provided Cognito domain in the bucket region. Register the exact deployed callback URL, such as `https://photos.example/minnelux/cognito-callback.html`. Provision the users who should open the library. [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
3. Register that app client with a Cognito identity pool and disable unauthenticated access. Map the intended users or groups to viewer and editor IAM roles. Put editors in the Cognito group entered in the app connection form. The default group is `writers`. Trust only the intended identity pool and authenticated identities. Give the default role zero S3 permissions, or deny unmapped identities. [Cognito role mapping](https://docs.aws.amazon.com/cognito/latest/developerguide/role-based-access-control.html)
4. Restrict `s3:ListBucket` on the bucket by prefix and scope `s3:GetObject` to the permitted keys. Viewers need those read permissions. Editors also need conditional `s3:PutObject` on library keys. Require create-only writes for immutable objects and allow conditional replacement only for the head. Protect existing originals and keep deletion, recovery, and backup privileges with separate administrative roles. [S3 policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html) · [Enforcing conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)

## Configure browser access

Set bucket CORS to your exact Minnelux origin. For listing, reading, and single PUT uploads, allow `GET`, `HEAD`, and `PUT`. Allow `Authorization`, `Content-Type`, `Range`, `If-Match`, `If-None-Match`, `x-amz-*`, `amz-sdk-invocation-id`, and `amz-sdk-request`. Expose `ETag`, `Content-Range`, and `Accept-Ranges`. CORS lets the browser send these requests. IAM controls what they can access. [S3 CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)

Choose **Amazon S3** in Minnelux and enter the bucket name, region, library prefix (defaults to `library`), AWS-provided Cognito origin (for example, `https://your-domain.auth.us-east-2.amazoncognito.com`), user pool ID, public app client ID, and identity pool ID. Allow that origin, the regional Cognito Identity endpoint, and the regional S3 endpoint in the app and worker Content Security Policy. Sign in as a Cognito library user. Keep AWS console and administrative credentials outside the app.

## If the library fails to open

| Symptom | Check |
| --- | --- |
| Cognito sign-in fails | Check the managed-login URL, app client, allowed callback URL, and user status. |
| Sign-in works but the library is denied | Check the identity pool role mapping, the bucket region, and IAM permissions on the selected prefix. |
| Browsing works but changes fail | Check that the user belongs to the configured editor group, is mapped to the correct IAM role, and that the role can write the head and snapshots. |
| The browser reports a network or cross-origin error | Check the regional S3 endpoint, exact app origin, allowed and exposed headers, and site Content Security Policy. |

Disconnecting clears the local app session. To remove someone's access, remove their role assignment and revoke their Cognito sessions. To deny already-issued AWS sessions before expiry, apply IAM revocation for the affected role. Role-wide revocation affects other sessions using that role. [Revoking IAM role sessions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html)
