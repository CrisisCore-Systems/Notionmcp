# Notion Research Agent

An AI-powered research agent that browses the web and structures findings directly into a Notion database — with human-in-the-loop approval before writing.

## What this repository is

This repository is a **small runnable Next.js app** for a Notion research workflow built with **Next.js, Gemini, Playwright, and the Notion MCP server**.

It contains the core application pieces:

- a React chat-style UI (`app/components/ChatUI.tsx`)
- a streaming research API route (`app/api/research/route.ts`)
- a streaming Notion write API route (`app/api/write/route.ts`)
- a Gemini agent loop (`lib/agent.ts`)
- Playwright browsing helpers (`lib/browser.ts`)
- a Notion MCP client wrapper (`lib/notion-mcp.ts`)

The repository is laid out as a standard Next.js App Router project, so `npm install`, `npm run dev`, and `npm run build` work once your environment variables are configured. The install story is intentionally explicit: the app launches the pinned local `@notionhq/notion-mcp-server` package from `node_modules`, not a best-effort runtime `npx` lookup.

To quickly crawl the repository and print its current state, run:

```bash
npm run status
```

Add `-- --json` if you want the same information as structured JSON.

## How it works

1. **You type a research prompt** (e.g. "Find the top 5 competitors to Linear")
2. **Gemini 2.0 Flash** searches the web and browses pages using Playwright
3. **You review** the structured data and proposed Notion schema
4. **One click** writes everything to Notion via the official Notion MCP server

After the write completes, the UI gives you a standard `https://www.notion.so/...` link. That link
can be opened in a browser or shared into the Notion app on Android.

### Using it effectively on Android

1. Run your research normally and write the results to Notion.
2. On the success screen, tap **Open in Notion** first.
3. If Android keeps the link in your browser instead of jumping into the app, use **Share link** or
   **Copy Android/web link**.
4. Open that same `https://www.notion.so/...` link from the Notion app or from Android's share
   sheet.

## Stack

- **LLM**: Gemini 2.0 Flash (free via Google AI Studio)
- **Search + browsing**: Serper (optional API-backed search) or DuckDuckGo fallback, plus Playwright for page browsing
- **Notion integration**: Pinned `@notionhq/notion-mcp-server` via MCP
- **Frontend**: Next.js 15 with streaming SSE

## Setup

### 1. Clone and install

```bash
git clone https://github.com/CrisisCore-Systems/Notionmcp.git
cd Notionmcp
npm install
# ↑ also runs `playwright install chromium` via postinstall
```

> **Current status:** the app boots with the included App Router structure. The Gemini and Notion features require valid environment variables, and the API routes will return clear setup errors until those are provided.

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free, no credit card |
| `SERPER_API_KEY` | Optional. [serper.dev](https://serper.dev) — enables API-backed search instead of the built-in DuckDuckGo fallback |
| `APP_ALLOWED_ORIGIN` | Optional. Exact origin to allow when you intentionally expose the API beyond localhost |
| `APP_ACCESS_TOKEN` | Optional. Shared secret required for any non-local API access |
| `NOTION_TOKEN` | [notion.so/profile/integrations](https://www.notion.so/profile/integrations) — create internal integration |
| `NOTION_PARENT_PAGE_ID` | Open a Notion page → copy the 32-char ID from the URL |

**Important**: Your Notion integration must have access to the parent page.
Go to the page in Notion → `...` menu → `Connect to` → select your integration.

By default, `/api/research` and `/api/write` only accept local requests. If you intentionally deploy the
app for tightly controlled private use, set **both** `APP_ALLOWED_ORIGIN` and `APP_ACCESS_TOKEN`, then
send the matching token in either the `x-app-access-token` header or a `Bearer` token. Cross-origin
requests are rejected either way. The built-in UI now includes an optional access-token field for that
private remote mode; leave it blank for normal localhost use.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Validation scripts

The repository now exposes the core checks directly:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The automated tests cover request-security rules, write-payload normalization, and smoke-level 400-path
checks for both API routes.

## Example prompts

- "Find the top 5 competitors to Notion in the productivity space"
- "Research the best free open-source React component libraries with GitHub stars"  
- "List the top VC firms focused on AI startups with portfolio info"
- "Find recent AI papers on reasoning and tool use from arXiv"
- "Research job postings for senior React engineers at Series B startups"

## Architecture

```
User prompt
    ↓
Gemini 2.0 Flash (agent loop)
    ├── search_web() → Serper API or DuckDuckGo adapter
    └── browse_url() → Playwright → target page
    ↓
Structured JSON (items + schema)
    ↓
Human approval UI ← YOU REVIEW HERE
    ↓
Notion MCP Server (subprocess via stdio)
    └── notion_create_database + notion_create_page × N (with row retries + resume support)
    ↓
Notion database ✅
```
