# Minnelux

[![Gitleaks](https://github.com/ricardocabral/minnelux/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/ricardocabral/minnelux/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Minnelux is a self-hosted web app designed for browsing, searching, and organizing photos and videos in private cloud storage you control.

- **Privacy.** Your browser connects directly to your storage and identity provider.
- **Preservation.** Organize your library with tags while keeping the original files intact.
- **Portability.** Keep the catalog and search index with your media so you can reopen the library in another browser or move it to another storage provider.

## Local setup

With Node.js 22 or newer installed, clone the repository and start the catalog and search benchmark.

```sh
git clone https://github.com/ricardocabral/minnelux.git
cd minnelux
node spikes/snapshots/serve.mjs
```

Open the benchmark and select **Run benchmark** to try catalog and search with sample data. [Open localhost](http://127.0.0.1:8782/)

For cloud setup, use a static HTTPS host, a private bucket, and provider sign-in configured for your site's origin. [Google Cloud Storage and OAuth setup](docs/prod/minnelux-prd.md#google-account-sign-in-and-gcs-access)

## Architecture

### Browser, sign-in, and storage

```mermaid
flowchart LR
    Host["Static HTTPS host"] -->|App files| Browser["Browser"]
    Browser <-->|Sign-in| Identity["Identity provider"]
    Browser <-->|Library reads and writes| Storage["Private object storage"]
```

### What the library stores

```mermaid
flowchart TD
    Storage["Private object storage"] --> Media["Originals and previews"]
    Storage --> Revision["Library revision"]
    Revision --> Catalog["Catalog and tags"]
    Revision --> Search["Search index"]
```

[Product specification](docs/prod/minnelux-prd.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
