# Minnelux

[![Checks](https://github.com/ricardocabral/minnelux/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/ricardocabral/minnelux/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Minnelux is an early-stage, self-hosted web app for browsing, searching, and organizing a private photo and video archive. This repository currently contains prototypes and the [product specification](docs/prod/minnelux-prd.md).

- Keep your library in private object storage you own.
- Serve the app over HTTPS as static files. The browser talks directly to your storage and identity provider.
- Preserve original media and keep the library format portable.

## Local setup

Install Node.js 22 or newer and run:

```sh
git clone https://github.com/ricardocabral/minnelux.git
cd minnelux
node --test spikes/flickr/reconcile.test.mjs
node spikes/snapshots/serve.mjs
```

Open [the local benchmark](http://127.0.0.1:8782/) in a browser. The [Google Cloud Storage prototype](spikes/gcs/README.md) has separate setup instructions.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
