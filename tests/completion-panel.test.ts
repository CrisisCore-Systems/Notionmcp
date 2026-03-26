import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompletionPanel } from "@/app/components/chat/CompletionPanel";

globalThis.React = React;

test("CompletionPanel surfaces queue lifecycle and research quality context", () => {
  const html = renderToStaticMarkup(
    createElement(CompletionPanel, {
      notionUrl: null,
      linkActionMessage: null,
      canShare: false,
      onShare: () => undefined,
      onCopy: () => undefined,
      onReset: () => undefined,
      writeSummary: {
        databaseId: "db123",
        itemsWritten: 3,
        propertyCount: 5,
        usedExistingDatabase: true,
        providerMode: "local-mcp",
        notionQueue: {
          databaseId: "queue-db",
          pageId: "page-123",
          title: "Acme backlog row",
          claimedBy: "Notion MCP Backlog Desk",
          claimedAt: "2026-03-25T08:00:00.000Z",
          runId: "run-123",
        },
        research: {
          mode: "deep",
          degraded: false,
          uniqueDomainCount: 5,
          sourceClassCount: 4,
          averageQualityScore: 86.5,
          rejectedUrlCount: 2,
          usedProviders: ["serper"],
        },
      },
    })
  );

  assert.match(html, /Queue lifecycle/);
  assert.match(html, /Acme backlog row/);
  assert.match(html, /In Progress → Needs Review → Packet Ready/);
  assert.match(html, /Research lane: deep/);
  assert.match(html, /average source quality score of 86.5/);
});
