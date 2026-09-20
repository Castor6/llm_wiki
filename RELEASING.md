# Releasing LLM Wiki Jev

The distribution repository is [Castor6/llm_wiki](https://github.com/Castor6/llm_wiki). The application uses the `io.github.castor6.llmwiki` identifier and checks this repository for updates. Upstream LLM Wiki settings are kept separate.

## Prepare a version

1. Update the application version in `package.json`, both root entries in `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `llm-wiki` package in `src-tauri/Cargo.lock`. Keep `extension/manifest.json` in sync for a numeric stable release.
2. Add user-facing changes to `src/lib/changelog.ts` and write `release-notes/v<version>.md`. Update the version and source tag in `DISTRIBUTION.txt`. Preserve the GPLv3 license, upstream notices, and the source-code information shipped with the application.
3. Run `npm ci`, `npm run test:mocks`, and `npm run build`. Review and merge the PR after its checks pass.

The workflow checks version consistency. A tag must match the application version exactly, for example `v0.7.0` for version `0.7.0`.

## Build installation packages for testing

Run **Actions → Build & Release → Run workflow** on the intended branch. This builds macOS Apple Silicon, Windows, Linux x86_64, Linux ARM64, and the browser extension. The resulting artifacts are retained for 14 days; a manual run does not create a GitHub Release.

Download the artifacts and test the application on the platforms you can access. A successful build does not prove that every UI or operating-system integration works. Use the same tested commit for the release tag.

## Publish a release

Push a `v*` version tag for the tested commit. The tag workflow runs validation and packaging again. Only after all required jobs succeed does the publishing job assemble and verify the artifacts, then publish the Release. Failed builds leave the version unpublished.

Stable numeric tags publish normal releases. Tags containing a prerelease suffix publish prereleases. The release includes checksums and source links, alongside the desktop packages and browser extension.

Do not move a tag after publishing it. Make fixes in a new version. Merging a PR on its own never publishes a Release.

## Credentials and signing

GitHub supplies `GITHUB_TOKEN` to the publishing job. Packaging does not require a Jev key and does not run the paid live API tests. Never bundle a developer API key or commit `.env.test.local`.

Apple signing and notarization use the optional `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` repository secrets. Without them, macOS builds are unsigned and unnotarized; describe this accurately in the release notes. The initial fork has no Apple signing secrets configured. Windows signing is not configured either.

The current matrix has no Intel Mac target. Adding one requires the matching native dependencies and a separate build and runtime check.
