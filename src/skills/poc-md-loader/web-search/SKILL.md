---
name: web-search
description: >
  Search the web using Brave Search API (primary) or Tavily (fallback).
  Returns ranked results with title, URL, and snippet. Requires at least
  one of BRAVE_SEARCH_KEY or TAVILY_API_KEY environment variables.
allowed-tools: "Bash(curl:*)"
metadata:
  version: "1.0.0"
  category: "search"
  tags: "brave tavily web-search"
  model-hint: "sonnet"
  env-required: "BRAVE_SEARCH_KEY TAVILY_API_KEY"
  env-mode: "at-least-one"
---

# web-search

Searches the web and returns structured results.

## Input

| Field   | Type    | Required | Default | Description              |
|---------|---------|----------|---------|--------------------------|
| `query` | string  | yes      | —       | Search query (1-512 chars) |
| `limit` | integer | no       | 5       | Max results (1-20)       |

## Output

```json
{
  "results": [
    { "title": "...", "url": "...", "snippet": "..." }
  ],
  "provider": "brave | tavily | replay"
}
```

## Execution

See `script.ts` for the execution logic. The script implements the same
Brave → Tavily fallback chain as the original `web-search.ts` TS skill.
