# codex-ark-proxy Test Plan

## Goal

Stop relying on manual trial-and-error for Codex <-> Ark compatibility changes.

## Core automated coverage

1. Model routing
   - GPT alias requests map to the configured Doubao downstream model.
   - Native `doubao-*` model requests pass through unchanged.

2. Request sanitization
   - Unsupported top-level fields are dropped.
   - Nested `external_web_access` is removed.
   - `text.verbosity` is removed.
   - `stream: true` is rewritten to `stream: false` for Ark.
   - `input[*].status` is preserved for tool output compatibility.

3. Tool compatibility
   - `function` tools are forwarded.
   - `custom` and `web_search` tools are filtered out.

4. Response normalization
   - Non-stream Ark responses are normalized to a valid Responses envelope.
   - Stream completion payload only keeps assistant message items.
   - Assistant output text extraction remains stable.

5. Local TUI metadata compatibility
   - Derived `doubao` metadata contains every field required by Codex local cache loading.
   - Incomplete metadata entries fail validation before being written into cache files.

## Manual regression checklist

1. `codex exec --model doubao-seed-2-0-pro-260215 "Reply with exactly: ok"`
2. `codex exec --model gpt-5.4 "Reply with exactly: ok"`
3. Open interactive `codex-arkproxy` and verify the request hits proxy `/responses`
4. Trigger a tool call and confirm no Ark error for `tool.type=custom`
5. Trigger a flow with tool output items and confirm no Ark error for missing `input.status`
6. Confirm proxy logs show expected `upstreamModel` and `downstreamModel`

## Future coverage to add

1. End-to-end Fastify route tests with mocked upstream fetch
2. SSE event-sequence validation against Codex client expectations
3. `models_cache.json` integrity validation for local TUI compatibility
4. Cache repair command that regenerates `doubao` metadata from a known-good template
