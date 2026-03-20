# Notion Research Agent

An AI-powered research agent that browses the web and structures findings directly into a Notion database — with human-in-the-loop approval before writing.

## How it works

1. **You type a research prompt** (e.g. "Find the top 5 competitors to Linear")
2. **Gemini 2.0 Flash** searches the web and browses pages using Playwright
3. **You review** the structured data and proposed Notion schema
4. **One click** writes everything to Notion via the official Notion MCP server

## Stack

- **LLM**: Gemini 2.0 Flash (free via Google AI Studio)
- **Browser automation**: Playwright (headless Chromium)
- **Notion integration**: Official `@notionhq/notion-mcp-server` via MCP
- **Frontend**: Next.js 15 with streaming SSE

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd notion-research-agent
npm install
# ↑ also runs `playwright install chromium` via postinstall
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free, no credit card |
| `NOTION_TOKEN` | [notion.so/profile/integrations](https://www.notion.so/profile/integrations) — create internal integration |
| `NOTION_PARENT_PAGE_ID` | Open a Notion page → copy the 32-char ID from the URL |

**Important**: Your Notion integration must have access to the parent page.
Go to the page in Notion → `...` menu → `Connect to` → select your integration.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

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
    ├── search_web() → Playwright → Google
    └── browse_url() → Playwright → target page
    ↓
Structured JSON (items + schema)
    ↓
Human approval UI ← YOU REVIEW HERE
    ↓
Notion MCP Server (subprocess via stdio)
    └── notion_create_database + notion_create_page × N
    ↓
Notion database ✅
```
