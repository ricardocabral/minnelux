# Connect a private Google Cloud Storage library

Deploy the [Minnelux web client](../../apps/web/README.md) or the [browser-based Flickr importer](../../apps/flickr-import/README.md) on an HTTPS site you control. The host serves the app files. After sign-in, the browser reads and writes your private Cloud Storage library directly using the signed-in Google account's IAM permissions.

If your app is already deployed, start with [Prepare storage and sign-in](#prepare-storage-and-sign-in).

## Build the apps

Use Node.js 24 or later and run these commands from the repository root. Run the block for each app you want to deploy. Use the same shell for the deployment steps so that `$stage` stays available.

```sh
stage=$(mktemp -d)
mkdir -p "$stage/public"
```

Build and stage the web client under `/web/`.

```sh
(cd apps/web && npm ci && npm run build) &&
  cp -R apps/web/dist "$stage/public/web"
```

Build and stage the browser-based Flickr importer under `/flickr-import/`.

```sh
(cd apps/flickr-import && npm ci && npm run build) &&
  cp -R apps/flickr-import/dist "$stage/public/flickr-import"
```

Publish the staged files, including scripts, styles, and workers. Enter the OAuth client ID and library settings in the app after deployment.

## Deploy to Firebase Hosting

1. Create or select a Firebase project you control with a dedicated default Hosting site. Install the Firebase CLI and run `firebase login`. [Firebase Hosting setup](https://firebase.google.com/docs/hosting/quickstart)
2. Save the following as `firebase.json` in `$stage`, alongside the `public/` directory. The headers cover both apps for Google Cloud Storage. If you also connect the web client to S3, add the origins from the [Amazon S3 guide](connect-amazon-s3.md#configure-browser-access) to the web client's policy.

   ```json
   {
     "hosting": {
       "public": "public",
       "headers": [
         {
           "source": "**",
           "headers": [
             { "key": "Cross-Origin-Opener-Policy", "value": "same-origin-allow-popups" },
             { "key": "Referrer-Policy", "value": "no-referrer" },
             { "key": "X-Content-Type-Options", "value": "nosniff" },
             { "key": "Cache-Control", "value": "no-cache" },
             { "key": "Content-Security-Policy", "value": "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com/gsi/ https://openidconnect.googleapis.com https://storage.googleapis.com https://sts.googleapis.com; frame-src https://accounts.google.com/gsi/; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' blob:; media-src blob:; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'" }
           ]
         }
       ]
     }
   }
   ```

3. Deploy from the staging directory. Replace `YOUR_FIREBASE_PROJECT_ID` with your project ID. Each deploy replaces the site's published file set, so stage every app you want to keep on that site.

   ```sh
   (cd "$stage" && firebase deploy --project YOUR_FIREBASE_PROJECT_ID --only hosting)
   ```

4. Open `/web/index.html` or `/flickr-import/index.html` at the Hosting URL printed by the CLI. Register the origin you opened, such as `https://YOUR_FIREBASE_PROJECT_ID.web.app`, in [Prepare storage and sign-in](#prepare-storage-and-sign-in).

## Deploy to Cloud Storage

1. Create a bucket for the static site in a Google Cloud project with billing enabled. Use this bucket only for app files and leave public access prevention unenforced on it. Your organization policy must allow public reads on the site bucket. Keep the library in its own private bucket with public access prevention enforced. [Cloud Storage static website setup](https://docs.cloud.google.com/storage/docs/hosting-static-website)
2. Install and sign in to the Google Cloud CLI. Replace `YOUR_STATIC_SITE_BUCKET` with the site bucket name, upload the staged files, and grant public read access to the site bucket.

   ```sh
   site_bucket=YOUR_STATIC_SITE_BUCKET
   gcloud storage rsync "$stage/public" "gs://$site_bucket" --recursive &&
     gcloud storage buckets add-iam-policy-binding "gs://$site_bucket" \
       --member=allUsers --role=roles/storage.objectViewer
   ```

3. Follow the [Cloud Storage HTTPS setup](https://docs.cloud.google.com/storage/docs/hosting-static-website#set-up-your-load-balancer-and-ssl-certificate) to attach the site bucket to an external Application Load Balancer and point a domain you control at its HTTPS frontend. On the load balancer's backend bucket, set the response headers shown in the [Firebase example](#deploy-to-firebase-hosting), including the Content Security Policy and the popup policy. [Configure custom response headers on a backend bucket](https://docs.cloud.google.com/load-balancing/docs/https/custom-headers-global#configure-custom-response-headers)
4. Once the TLS certificate is active, open `/web/index.html` or `/flickr-import/index.html` at your HTTPS domain. Use that domain's origin in [Prepare storage and sign-in](#prepare-storage-and-sign-in).

## Prepare storage and sign-in

1. Create a private Cloud Storage bucket and enable uniform bucket-level access and public access prevention. Choose an unused prefix such as `library`, or record the bucket and prefix of an existing Minnelux library. A separate bucket per library keeps IAM easier to scope. [Create a bucket](https://docs.cloud.google.com/storage/docs/creating-buckets) · [Public access prevention](https://docs.cloud.google.com/storage/docs/public-access-prevention)
2. Grant users who browse the library **Storage Object Viewer** on the library bucket. Give editors **Storage Object Creator** as well. To let editors replace the head, create a custom role with `storage.objects.delete` and grant it on the library bucket with the condition `resource.name == "projects/_/buckets/<bucket>/objects/<prefix>/head.json"`. Substitute the bucket and prefix you chose in step 1. Check for broader inherited grants. [Cloud Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles) · [Create a custom role](https://docs.cloud.google.com/iam/docs/creating-custom-roles) · [IAM Conditions](https://docs.cloud.google.com/storage/docs/access-control/iam#conditions) · [Overwrite permissions](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert#required_permissions)
3. In Google Auth Platform, configure the consent screen and create an OAuth client of type **Web application**. For personal Gmail accounts, use an External audience and add the intended accounts as test users while the app is in Testing. Under **Authorized JavaScript origins**, enter your site's scheme and hostname, plus any non-default port. For example, for `https://photos.example.com/web/index.html`, register `https://photos.example.com`. Both apps can use the same OAuth client when they share an origin. For local development on port 5173, register `http://localhost` and `http://localhost:5173` and open the app on localhost. Copy the public client ID for the next step. [Google OAuth web setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)

## Open the library

Enter the bucket name, library prefix, and public Google OAuth client ID in the app. In the web client, choose **Read only** or **Read and edit** and connect to **Google Cloud Storage**. Select **Remember login** in the web client if you want the library to reopen on reload while the current token is valid. Use it only in a trusted browser. In the importer, follow the Flickr workflow. [Remember a Google Cloud Storage login](../../apps/web/README.md#stay-connected-across-reloads) · [Flickr workflow](../../apps/flickr-import/README.md#import-a-flickr-export)

To verify access to an existing library, open a known photo. For a new library, use a test prefix. In the web client, publish a synthetic JPEG from the **Import** dialog, then reopen the library and search for the photo. In the Flickr importer, publish and reopen a synthetic export. [Verify the Flickr importer with a synthetic export](../../apps/flickr-import/README.md#verify-with-a-synthetic-export) · [Library compatibility and prefixes](library-compatibility.md#library-formats)

If the app fails to load, check that the build files are available under the chosen path and that the host returns the configured headers for the page and worker scripts. If sign-in fails, check the registered origin, OAuth audience, and signed-in account. If sign-in works but the library is denied, check bucket IAM and the selected access mode. The Cloud Storage JSON API uses Google's CORS defaults. [Cloud Storage CORS](https://docs.cloud.google.com/storage/docs/cross-origin)
