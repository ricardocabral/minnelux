# Connect a private Google Cloud Storage library

Configure a private bucket and Google sign-in for the [web client](../../apps/web/README.md) or the [Flickr importer](../../apps/flickr-import/README.md).

## Prepare storage and sign-in

1. Create a private Cloud Storage bucket and enable uniform bucket-level access and public access prevention. Choose an unused prefix such as `library`, or record the bucket and prefix of an existing Minnelux library. A separate bucket per library keeps IAM easier to scope. [Create a bucket](https://docs.cloud.google.com/storage/docs/creating-buckets) · [Public access prevention](https://docs.cloud.google.com/storage/docs/public-access-prevention)
2. Grant users who browse the library **Storage Object Viewer** on the library bucket. Give editors **Storage Object Creator** as well. Use a conditional grant for `storage.objects.delete` on the exact object `projects/_/buckets/<bucket>/objects/<prefix>/head.json` so editors can replace the head. Check for broader inherited grants. [Cloud Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles) · [IAM Conditions](https://docs.cloud.google.com/storage/docs/access-control/iam#conditions) · [Overwrite permissions](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert#required_permissions)
3. In Google Auth Platform, configure the consent screen and create an OAuth client of type **Web application**. For personal Gmail accounts, use an External audience and add the intended accounts as test users while the app is in Testing. Add the exact app origin to **Authorized JavaScript origins**, including scheme and any non-default port. For the hosted web client or importer, enter `https://minnelux.web.app`. For local web development on port 5173, register `http://localhost` and `http://localhost:5173` and open the app on localhost. [Google OAuth web setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)

## Open the library

Enter the bucket name, library prefix, and public Google OAuth client ID in the app. In the web client, choose **Read only** or **Read and edit** and connect to **Google Cloud Storage**. Select **Remember login** in the web client if you want the library to reopen on reload while the current token is valid. Use it only in a trusted browser. In the importer, follow the Flickr workflow. [Remember a Google Cloud Storage login](../../apps/web/README.md#stay-connected-across-reloads) · [Flickr workflow](../../apps/flickr-import/README.md#import-a-flickr-export)

To verify access, open a known photo in an existing library. For a new library, try publishing a synthetic JPEG from the web client's **Import** dialog in a test prefix, then reopen it and search for the photo. The [compatibility reference](library-compatibility.md#library-formats) explains which prefix to use if you use both apps.

If sign-in fails, check the registered origin, OAuth audience, and signed-in account. If sign-in works but the library is denied, check bucket IAM and the selected access mode. The Cloud Storage JSON API uses Google's CORS defaults. [Cloud Storage CORS](https://docs.cloud.google.com/storage/docs/cross-origin)
