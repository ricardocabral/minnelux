# Explore your first Minnelux library

Use a local sample library to find a photo, inspect its Flickr details, and download the original. You need Node.js 24 or later and a checkout of Minnelux. The sample uses synthetic media and requires no cloud credentials.

## Open the sample

From the repository root, run:

```sh
cd apps/web
npm ci
npm run build -- --mode test
npm run preview -- --mode test --host 127.0.0.1 --port 4173 --strictPort
```

Open [the local sample](http://127.0.0.1:4173/) and choose **Open sample library**. The gallery opens in **All Media**.

## Find and inspect a photo

1. Choose **Travel** in the collections navigation. On a narrow screen, open **Collections** first. You should see the album cover and the description **Across the river**.
2. Open **Forêt** and look under **Details**. You should see the original Flickr caption, **Original caption**.
3. In the viewer toolbar, choose **Download original**. Open the downloaded JPEG to see the stored original.
4. Close the viewer and enter `foret` in the search box. **Forêt** appears in the search results.

Stop the local server with Ctrl+C. To open your own library, follow the [Google Cloud Storage guide](connect-google-cloud-storage.md). To host the web client, use the [regular build](../../apps/web/README.md#self-host-the-web-client).
