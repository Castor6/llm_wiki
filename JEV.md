# Jev integration in this fork

This fork adds optional TypeSafe Jev judgments to LLM Wiki. It retains the upstream GPLv3 license and notices. Integration changes were introduced on 2026-09-20.

For the product background, implementation rationale, validation scope, and release behavior, see the [Chinese design document](JEV_DESIGN_CN.md).

## Setup

In the desktop app, open **Settings → Jev**, enter a TypeSafe API key, and test the connection. The test sends a synthetic sentence only. Enable Jev to check duplicate candidates and sample claims from source summaries. A generative model remains necessary for extraction, writing, and chat.

The default model is pinned to `jev-1.13.0`. Credentials use the app's existing global settings store, outside project folders and project exports. This follows upstream storage conventions; it is not OS-keychain encryption. Jev requests send the relevant text to TypeSafe's official API. Keys are never included in judgment reports or diagnostics.

## What changes

- **Duplicate detection:** the existing detector proposes candidates; Jev checks each candidate pair. Results remain suggestions requiring the existing merge confirmation. Low-certainty and unknown results remain visible. A pairwise match does not automatically merge an entire group. User-excluded pairs stay excluded. Service errors are surfaced rather than silently returning unchecked results.
- **Citation review:** after writing a source summary, the generation model selects up to five factual excerpts and their proposed source quotes. Code checks that claims exist in the saved summary and quotes exist in the original parsed source. Jev judges support, contradiction, or insufficient evidence using local source context. Issues appear in Review with source and summary links.
- **Scope:** this is an advisory sample of the saved source summary, not verification of every Wiki page or a gate preventing writes. The initial pass supports at most 28,000 source characters and 12,000 summary characters; larger inputs, extraction failures, edits during checking, and service failures receive a pending-review item. Sources are not silently truncated to claim success.
- **History:** reports live in `.llm-wiki/jev-citations/`. Cache identity includes original parsed source, saved summary, model, and prompt version. Moving model aliases are re-evaluated. Later checks retire obsolete Jev review items while preserving unrelated reviews and user decisions for unchanged findings. Re-importing an unchanged source can retry a pending check without regenerating its Wiki pages.

Jev's confidence measures its output distribution, not the probability that a fact is objectively true. The initial review threshold is a routing heuristic, not a calibrated accuracy claim. English and Chinese need separate evaluation on representative material. Source-summary sampling also depends on the generation model selecting useful claims, and local context can miss distant qualifications.

## Developer verification

Copy `.env.test.example` to `.env.test.local` and put the key after `TYPESAFE_API_KEY=`. `.env.test.local` is ignored by Git and read only by the test setup; it does not configure the running desktop app and is never bundled through a `VITE_` variable. Do not put a real key in the example file.

```sh
npm ci
npm run test:mocks
npm run build
npm run test:jev:live
```

The last command explicitly opts into three small synthetic API calls (English, Chinese, and the citation helper). It requires a key, uses a small amount of paid API usage, and prints only model, verdicts, and token usage. Ordinary unit tests do not call TypeSafe. These smoke tests verify connectivity and simple integration behavior, not general model quality.

The desktop build still uses upstream Tauri prerequisites, including a Rust toolchain. See the main README for desktop development.

- [TypeSafe API](https://docs.typesafe.ai/api)
- [Model limits](https://docs.typesafe.ai/models)
- [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
