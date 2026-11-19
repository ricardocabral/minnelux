# Minnelux Agent Cookbook

## Set up the local sample

Paste this prompt into your coding agent to run Minnelux with a synthetic
library that needs no cloud account.

```text
Set up Minnelux in this workspace. Reuse the existing checkout or clone
https://github.com/ricardocabral/minnelux if needed. Read AGENTS.md and
.agents/skills/minnelux/SKILL.md, then follow docs/prod/first-library.md to run
the local sample. Verify that the sample library opens and a photo can be viewed.
Tell me the local URL, what you verified, and how to stop the server.
```

## Install the Minnelux skill

The Minnelux skill guides your coding agent through local setup, self-hosting,
and troubleshooting private libraries on Google Cloud Storage or Amazon S3.
Install it so the agent can find the right steps, verify that your library
opens, and keep it compatible with the Flickr importer when needed.

Open a Minnelux checkout that contains the [Minnelux skill](../../.agents/skills/minnelux/SKILL.md).

- **Codex.** Open the checkout as your workspace. Codex discovers the skill in
  `.agents/skills/`. Type `$` in the prompt and select `minnelux`.
  [Codex skills documentation](https://developers.openai.com/codex/skills)
- **Claude Code.** Run these commands once from the repository root to link the
  skill into the project skills directory. Then open Claude Code in the
  checkout and enter `/minnelux`.
  [Claude Code skills documentation](https://code.claude.com/docs/en/skills#choose-where-skills-load)

  ```sh
  mkdir -p .claude/skills
  ln -s ../../.agents/skills/minnelux .claude/skills/minnelux
  ```

- **Other agents.** Ask your agent to read `.agents/skills/minnelux/SKILL.md`
  before it works on Minnelux.

## Adapt the prompt for your library

For an existing library, replace the local sample request with a request for
read-only access. Include your storage provider, bucket name, and library prefix.
Complete sign-in in your browser. [Google Cloud Storage setup](connect-google-cloud-storage.md) · [Amazon S3 setup](connect-amazon-s3.md)

## Set up on Google Cloud

Fill in the project, bucket, library prefix, and account placeholders before
pasting. Use your existing HTTPS app URL or specify the Firebase Hosting site
you want the agent to use. [Minnelux GCS setup](connect-google-cloud-storage.md) · [Firebase Hosting targets](https://firebase.google.com/docs/hosting/multisites)

```text
Set up Minnelux with Google Cloud Storage in project <GCP_PROJECT_ID>,
using location <GCS_LOCATION>, bucket <GCS_BUCKET> and library prefix
<LIBRARY_PREFIX>. Use <APP_URL_OR_FIREBASE_HOSTING_SITE> to serve the web
client. My Google viewer accounts are <VIEWER_ACCOUNTS> and editor
accounts are <EDITOR_ACCOUNTS>. Confirm the active project and intended
resources before changing them. Reuse resources that already match.

1. Read AGENTS.md, .agents/skills/minnelux/SKILL.md,
   docs/prod/connect-google-cloud-storage.md, and apps/web/README.md.
2. Use a private GCS bucket with uniform bucket-level access and public
   access prevention. Grant readers Storage Object Viewer. Add Storage
   Object Creator for editors and grant storage.objects.delete only on the
   exact <LIBRARY_PREFIX>/head.json object so editors can advance the head.
   Check inherited access before relying on the viewer/editor split.
3. If deploying the app, build the regular apps/web/dist/ using Node.js 24
   or later and serve the static files over HTTPS with the documented
   security headers. On Firebase Hosting, verify the project and site
   targeted by the deploy and preserve other routes on a shared site.
4. Configure the consent screen in Google Auth Platform and create or
   reuse a Web application OAuth client. For an External app in Testing,
   add the intended accounts as test users. Register the exact app origin
   under Authorized JavaScript origins, including any non-default port.
   Use browser Google sign-in and the Cloud Storage JSON API. Keep any
   secrets or tokens out of the build, chat, and logs.
5. Give me the URL, bucket, prefix, and public OAuth client ID. Have me
   complete Google sign-in in the browser. Open a known photo in Read only
   mode for an existing library. For a new write-enabled setup, use an
   isolated test prefix with equivalent scoped permissions. Publish a
   synthetic JPEG, make a second edit to exercise head replacement, and
   reconnect to check that the photo opens and is searchable. Report
   what you verified.
```

## Set up on AWS

Fill in the account, region, buckets, library prefix, and user placeholders.
Choose an existing HTTPS app URL or ask the agent to use the CloudFront URL.
[Minnelux S3 setup](connect-amazon-s3.md) · [CloudFront origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)

```text
Set up Minnelux in AWS account <AWS_ACCOUNT_ID> and region <AWS_REGION>
with private media bucket <S3_LIBRARY_BUCKET> and library prefix
<LIBRARY_PREFIX>. For hosting, use <APP_URL_OR_CLOUDFRONT> and, if needed,
private app assets bucket <APP_ASSETS_BUCKET>. Set up viewer accounts
<VIEWER_ACCOUNTS> and editor accounts <EDITOR_ACCOUNTS>. Confirm the
active account, region, and resource names before making changes.

1. Read AGENTS.md, .agents/skills/minnelux/SKILL.md,
   docs/prod/connect-amazon-s3.md, and apps/web/README.md.
2. Use a general-purpose S3 library bucket with all Block Public Access
   settings enabled. For CloudFront hosting, build regular apps/web/dist/
   using Node.js 24 or later and deploy only those assets to a separate
   private S3 bucket. Use its REST origin with CloudFront origin access
   control and restrict the bucket grant to that distribution. Serve
   index.html at the app entry point and require HTTPS.
3. Set up a Cognito user pool with an AWS-provided managed-login domain
   and a public app client without a secret. Enable the authorization
   code grant and the openid scope for the app's PKCE flow. Register
   the exact deployed URL ending in
   cognito-callback.html, including the app subpath if used.
4. Connect the app client to a same-region Cognito identity pool with
   unauthenticated identities disabled. Map users to viewer and editor
   IAM roles and the configured editor group (default writers). Limit
   role trust to the intended authenticated identity pool and deny access
   to unmapped identities. Scope ListBucket to the library prefix and
   GetObject to its keys. Editors need conditional PutObject with
   If-None-Match: * for immutable objects and head creation, and If-Match
   for head updates. Keep deletion and recovery with administrators.
5. Apply the exact-origin S3 CORS methods, request headers, and exposed
   headers from the S3 guide. Set the app and worker Content Security
   Policies for Cognito and the regional S3 endpoint as described there.
6. Give me the app URL, bucket, region, prefix, managed-login origin,
   public app client ID, both pool IDs, and editor group. Have me sign in
   in the browser. Check that a viewer can open a photo and has no Import
   action. In an isolated test prefix with equivalent scoped permissions,
   have an editor publish a synthetic JPEG, make a second edit to exercise
   head replacement, and reopen the photo. Report what you verified.
```

## Import photos from a local folder

**Before pasting, replace `<PHOTO_DIRECTORY>` with the absolute path of the
folder you intend to upload.** Choose either GCS or S3 and fill in the
destination bucket, prefix, and tags. Use a separate prefix when the existing
library still receives updates from the standalone Flickr importer.
[Library compatibility and import limits](library-compatibility.md)

For a few JPEGs, use the web client's **Import** dialog. For a directory,
extend that flow and reuse Flickr preview or metadata code where it fits.
The web client already supports both providers and publishes v2 manifests.
The standalone Flickr importer writes v1 to GCS and expects Flickr ZIPs.
[Web client import design](../dev/web-client/SPEC.md#repository-indexing-and-imports) · [Storage format and publication](../dev/storage/SPEC.md#library-format-and-publication)

```text
Import the photos in <PHOTO_DIRECTORY> into my private Minnelux library
on <GCS_OR_S3> in bucket <BUCKET> at prefix <LIBRARY_PREFIX>. Use two
distinct tags, <FIRST_TAG> and <SECOND_TAG>. Keep reads within the
specified folder, tell me whether subfolders are included, and leave
the source files untouched.

1. Read .agents/skills/minnelux/SKILL.md and the library format and
   publication section of docs/dev/storage/SPEC.md. Use the web client's
   photo import, library repository, and storage adapter for my provider.
   If this checkout only supports one photo per import, add folder
   selection to that flow. Reuse its JPEG validation, preview generation,
   and publication. Have me select the folder if the browser requires it.
2. Start with a dry run. List the target bucket and prefix, supported file
   count and bytes, and skipped or duplicate candidates. Follow the
   current limits and report unsupported formats. Test the workflow and
   retry behavior with synthetic photos. Wait for my approval before
   uploading real photos.
3. Preserve original bytes and filenames. Use SHA-256-keyed originals/ and
   previews/ under the library prefix, with provider-relative media
   references in the catalog. Use the repository to generate the gzip
   catalog and text/tag indexes and the v2 revision manifest. Write
   immutable objects first and publish via a conditional head.json update.
   Preserve existing entries. Reuse the same operation ID on retry and
   check its receipt before replaying an uncertain write.
4. Reopen the library in a fresh authorized browser session. Search for
   representative imported photos, open their previews, and compare a
   downloaded original with its source SHA-256. Report the revision ID,
   imported and skipped counts, and any unresolved results.
```
