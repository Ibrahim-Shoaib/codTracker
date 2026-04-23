import { useState } from "react";
import {
  TextField,
  Text,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Collapsible,
  Thumbnail,
} from "@shopify/polaris";

// Shared COGS table — used in onboarding step 3 and /app/cogs settings page.
// Renders inside a parent <Form>. Hidden inputs carry all variant data on submit.
// Props:
//   products:  [{ shopify_product_id, product_title, image_url, variants: [{ shopify_variant_id,
//               shopify_product_id, product_title, variant_title, sku, shopify_cost }] }]
//   costsMap:  { [shopify_variant_id]: unit_cost }  — previously saved costs from DB
export default function COGSTable({ products, costsMap }) {
  // Per-variant cost state. Priority: saved DB cost → Shopify cost field → empty.
  const [costs, setCosts] = useState(() => {
    const map = {};
    for (const product of products) {
      for (const v of product.variants) {
        const db = costsMap[v.shopify_variant_id];
        map[v.shopify_variant_id] =
          db != null             ? String(db) :
          v.shopify_cost != null ? String(v.shopify_cost) : "";
      }
    }
    return map;
  });

  // Auto-expand products whose variants already have differing costs.
  const [expanded, setExpanded] = useState(() => {
    const set = new Set();
    for (const product of products) {
      if (product.variants.length <= 1) continue;
      const vals = product.variants.map(v => {
        const db = costsMap[v.shopify_variant_id];
        return db != null ? String(db) : v.shopify_cost != null ? String(v.shopify_cost) : "";
      });
      if (new Set(vals).size > 1) set.add(product.shopify_product_id);
    }
    return set;
  });

  const toggleExpanded = (productId) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId); else next.add(productId);
      return next;
    });
  };

  const applyToAll = (product, val) => {
    setCosts(prev => {
      const next = { ...prev };
      for (const v of product.variants) next[v.shopify_variant_id] = val;
      return next;
    });
  };

  const updateOne = (variantId, val) =>
    setCosts(prev => ({ ...prev, [variantId]: val }));

  const productCostValue = (product) => {
    const vals = product.variants.map(v => costs[v.shopify_variant_id] ?? "");
    return new Set(vals).size === 1 ? vals[0] : "";
  };

  const isMixed = (product) =>
    new Set(product.variants.map(v => costs[v.shopify_variant_id] ?? "")).size > 1;

  const preFillCount = products.filter(p =>
    p.variants.some(v => v.shopify_cost != null && costsMap[v.shopify_variant_id] == null)
  ).length;

  const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
  const filledCount   = Object.values(costs).filter(v => Number(v) > 0).length;

  if (products.length === 0) {
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        No active products found in your Shopify store.
      </Text>
    );
  }

  // Thumbnail is 40px wide; gap between thumb and title is 12px → 52px total indent
  // used to align expanded variant rows with the product title.
  const VARIANT_INDENT = 52;

  return (
    <BlockStack gap="400">
      {preFillCount > 0 && (
        <Banner tone="info">
          {preFillCount} product{preFillCount !== 1 ? "s" : ""} pre-filled from your
          Shopify cost data. Review and adjust as needed.
        </Banner>
      )}

      <BlockStack gap="200">
        {products.map((product) => {
          const isExpanded   = expanded.has(product.shopify_product_id);
          const mixed        = isMixed(product);
          const bulkVal      = productCostValue(product);
          const multiVariant = product.variants.length > 1;
          const anyShopifyCost = product.variants.some(v => v.shopify_cost != null);

          return (
            <Box
              key={product.shopify_product_id}
              background="bg-surface"
              borderWidth="025"
              borderColor="border"
              borderRadius="200"
              padding="400"
            >
              <BlockStack gap="300">

                {/* ── Product header row ── */}
                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>

                  {/* Left: thumbnail + title block — shrinks and truncates */}
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1, minWidth: 0 }}>
                    <div style={{ flexShrink: 0 }}>
                      <Thumbnail
                        source={product.image_url || ""}
                        size="small"
                        alt={product.product_title}
                      />
                    </div>

                    <div style={{ minWidth: 0 }}>
                      {/* Title — truncates with ellipsis when narrow */}
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Text fontWeight="semibold" variant="bodyMd" as="span">
                          {product.product_title}
                        </Text>
                      </div>

                      {/* Badges row */}
                      {(multiVariant || anyShopifyCost) && (
                        <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
                          {multiVariant && (
                            <Badge>{product.variants.length} variants</Badge>
                          )}
                          {anyShopifyCost && (
                            <Badge tone="info">Pre-filled</Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right: cost input + expand button — never shrinks */}
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
                    <div style={{ width: 160 }}>
                      <TextField
                        label={`Cost for ${product.product_title}`}
                        labelHidden
                        type="number"
                        min="0"
                        step="0.01"
                        prefix="PKR"
                        value={bulkVal}
                        placeholder={mixed ? "Mixed" : "0.00"}
                        onChange={(val) => applyToAll(product, val)}
                        autoComplete="off"
                      />
                    </div>
                    {multiVariant && (
                      <div style={{ minWidth: 80 }}>
                        <Button
                          variant="plain"
                          onClick={() => toggleExpanded(product.shopify_product_id)}
                        >
                          {isExpanded ? "Collapse" : "Per variant"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Expanded per-variant rows ── */}
                {multiVariant && (
                  <Collapsible
                    open={isExpanded}
                    id={`variants-${product.shopify_product_id}`}
                    transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                  >
                    <Box
                      paddingBlockStart="300"
                      borderBlockStartWidth="025"
                      borderColor="border-subdued"
                    >
                      <BlockStack gap="250">
                        {product.variants.map((v) => {
                          const displayTitle =
                            v.variant_title === "Default Title" ? "Default" : v.variant_title;
                          return (
                            <div
                              key={v.shopify_variant_id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "16px",
                                paddingLeft: VARIANT_INDENT,
                              }}
                            >
                              {/* Left: variant title + SKU (truncates) + badge */}
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1 }}>
                                  <Text variant="bodySm" as="span">{displayTitle}</Text>
                                  {v.sku && (
                                    <Text variant="bodySm" tone="subdued" as="span">
                                      {" · "}{v.sku}
                                    </Text>
                                  )}
                                </div>
                                {v.shopify_cost != null && (
                                  <div style={{ flexShrink: 0 }}>
                                    <Badge tone="info" size="small">
                                      Shopify: PKR {v.shopify_cost}
                                    </Badge>
                                  </div>
                                )}
                              </div>

                              {/* Right: cost input */}
                              <div style={{ width: 160, flexShrink: 0 }}>
                                <TextField
                                  label={displayTitle}
                                  labelHidden
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  prefix="PKR"
                                  value={costs[v.shopify_variant_id] ?? ""}
                                  onChange={(val) => updateOne(v.shopify_variant_id, val)}
                                  autoComplete="off"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </BlockStack>
                    </Box>
                  </Collapsible>
                )}
              </BlockStack>

              {/* Hidden inputs — always rendered so every variant is submitted */}
              {product.variants.map((v) => (
                <span key={v.shopify_variant_id}>
                  <input type="hidden" name={`cost_${v.shopify_variant_id}`}    value={costs[v.shopify_variant_id] ?? "0"} />
                  <input type="hidden" name={`product_${v.shopify_variant_id}`} value={v.shopify_product_id} />
                  <input type="hidden" name={`sku_${v.shopify_variant_id}`}     value={v.sku} />
                  <input type="hidden" name={`ptitle_${v.shopify_variant_id}`}  value={v.product_title} />
                  <input type="hidden" name={`vtitle_${v.shopify_variant_id}`}  value={v.variant_title} />
                </span>
              ))}
            </Box>
          );
        })}
      </BlockStack>

      <Text as="p" variant="bodySm" tone="subdued">
        {filledCount} of {totalVariants} variant{totalVariants !== 1 ? "s" : ""} have costs entered
      </Text>
    </BlockStack>
  );
}
