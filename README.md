# Minnelux

[![Gitleaks](https://github.com/ricardocabral/minnelux/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/ricardocabral/minnelux/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Minnelux is a self-hosted web app for browsing, searching, and organizing media in private cloud storage you control. It keeps your originals and the library catalog in your bucket.

## Tutorial

- [Explore a sample library](docs/prod/first-library.md) to browse a Flickr album, inspect photo details, and find a photo by name without a cloud account.

## How-to guides

- [Run or self-host the web client](apps/web/README.md)
- [Connect Google Cloud Storage with Google sign-in](docs/prod/connect-google-cloud-storage.md)
- [Connect Amazon S3 with Cognito](docs/prod/connect-amazon-s3.md)
- [Keep Google libraries connected across reloads](apps/web/README.md#stay-connected-across-reloads)
- [Import or browse a Flickr account export](apps/flickr-import/README.md)

## Reference

- [Library compatibility and import limits](docs/prod/library-compatibility.md)
- [Storage and library format specification](docs/dev/storage/SPEC.md)

## Explanation

- [How the browser, identity provider, and private storage work together](docs/prod/minnelux-prd.md#3-browser-architecture)

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
