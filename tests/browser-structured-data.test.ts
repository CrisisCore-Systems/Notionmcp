import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStructuredDataLines,
  normalizeStructuredPageData,
} from "@/lib/browser";

test("normalizeStructuredPageData lifts JSON-LD, Open Graph, and schema fields", () => {
  const structured = normalizeStructuredPageData({
    canonicalUrl: "https://example.com/products/acme-widget",
    openGraph: {
      "og:title": "Acme Widget",
      "og:description": "Fast widget for modern teams",
      "og:url": "https://example.com/products/acme-widget",
    },
    schemaFields: [
      { name: "price", value: "29.99" },
      { name: "brand", value: "Acme" },
    ],
    jsonLdBlocks: [
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Acme Widget",
        description: "Fast widget for modern teams",
        brand: {
          "@type": "Brand",
          name: "Acme",
        },
        offers: {
          "@type": "Offer",
          price: "29.99",
          priceCurrency: "USD",
        },
      }),
    ],
  });

  assert.equal(structured?.canonicalUrl, "https://example.com/products/acme-widget");
  assert.equal(structured?.openGraph?.["og:title"], "Acme Widget");
  assert.equal(structured?.schemaFields?.price, "29.99");
  assert.equal(structured?.jsonLd?.[0]?.type, "Product");
  assert.equal(structured?.jsonLd?.[0]?.properties.name, "Acme Widget");
  assert.equal(structured?.jsonLd?.[0]?.properties.description, "Fast widget for modern teams");

  const lines = buildStructuredDataLines(structured);

  assert.match(lines.join("\n"), /Open Graph title: Acme Widget/);
  assert.match(lines.join("\n"), /Schema price: 29.99/);
  assert.match(lines.join("\n"), /JSON-LD Product.name: Acme Widget/);
});
