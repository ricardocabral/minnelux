# Contributing to Minnelux

Use [GitHub Issues](https://github.com/ricardocabral/minnelux/issues) for bugs and feature ideas. For bugs, include steps to reproduce, what you expected, and your browser and operating system. Report vulnerabilities privately through the [security policy](SECURITY.md).

Follow the [web client setup](apps/web/README.md#run-locally) or the [importer setup](apps/flickr-import/README.md#self-host-the-importer), then submit a focused pull request with a short description and the checks you ran. For browser changes, include which browsers you tested. Follow the [code of conduct](CODE_OF_CONDUCT.md).

Use synthetic media and metadata in tests and examples. Run `gitleaks git --redact .` with Gitleaks installed before sharing commits.

## Frontend security

- Keep live credentials out of source, build configuration, browser storage, and logs. Keep short-lived access tokens in memory and request the narrowest provider scopes and permissions needed.
- Validate imported data and provider responses at runtime. Render filenames, metadata, and other untrusted values as text. Preserve the deployment's Content Security Policy when adding browser capabilities.
- When adding an npm dependency, commit the lockfile and use `npm ci` in CI so the dependency graph reflects reproducible installs.
