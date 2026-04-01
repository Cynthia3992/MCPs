# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repo contains two Supabase Edge Function MCP servers written in TypeScript/Deno:

- **OPENBRAIN** — personal knowledge capture and retrieval ("second brain")
- **competitor-research** — competitor/creator research capture and retrieval

Both follow the same pattern: a Hono HTTP server wrapping an MCP server, deployed as Supabase Edge Functions.

## Deployment Commands

Both projects use the Supabase CLI. Run from the project root (`OPENBRAIN/` or `competitor-research/`):

```bash
# Deploy a function
supabase functions deploy open-brain-mcp --project-ref <ref>
supabase functions deploy telegram-capture --project-ref <ref>
supabase functions deploy open-brain-competitors --project-ref <ref>

# Set secrets (env vars) for deployed functions
supabase secrets set OPENROUTER_API_KEY=... --project-ref <ref>
supabase secrets set MCP_ACCESS_KEY=... --project-ref <ref>

# Local dev
supabase start
supabase functions serve open-brain-mcp --env-file .env.local
```

## Architecture

### Common pattern across both MCPs

Each function in `supabase/functions/<name>/index.ts`:
1. Creates an `McpServer` instance and registers tools
2. Wraps it in a Hono app that checks auth before every request
3. Serves via `Deno.serve(app.fetch)`

Dependencies are declared in each function's `deno.json` (no `node_modules`, no `package.json`).

### Auth

Both MCP servers accept an access key via `x-brain-key` header **or** `?key=` query param, checked against `MCP_ACCESS_KEY` env var. The telegram-capture function uses a separate `TELEGRAM_CAPTURE_SECRET` passed as `?secret=` in the webhook URL.

### Database (Supabase)

**OPENBRAIN** — `thoughts` table:
- `content` (text), `embedding` (vector), `metadata` (jsonb), `archived` (bool), `created_at`
- `match_thoughts` RPC for vector similarity search

**competitor-research** — `competitor_content` table:
- `content`, `embedding`, `metadata`, `archived`, `creator`, `platform`, `content_url`, `posted_date`, `created_at`
- `match_competitor_content` RPC for vector similarity search

Metadata is auto-extracted via OpenRouter (`gpt-4o-mini`) and embeddings via OpenRouter (`text-embedding-3-small`).

### Required environment variables

| Var | Used by |
|-----|---------|
| `SUPABASE_URL` | both |
| `SUPABASE_SERVICE_ROLE_KEY` | both |
| `OPENROUTER_API_KEY` | both |
| `MCP_ACCESS_KEY` | both MCP servers |
| `TELEGRAM_BOT_TOKEN` | telegram-capture only |
| `TELEGRAM_CAPTURE_SECRET` | telegram-capture only |

### OPENBRAIN tools
`capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`, `archive_thought`, `unarchive_thought`

### competitor-research tools
`capture_competitor_content`, `search_competitors`, `list_competitor_content`, `competitor_stats`, `archive_competitor_content`, `get_competitor_content`
