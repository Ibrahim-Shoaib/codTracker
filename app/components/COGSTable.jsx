import { useState } from "react";
import {
  TextField,
  Text,
  Badge,
  Banner,
  BlockStack,
  Box,
  InlineStack,
  Button,
  Collapsible,
} from "@shopify/polaris";

// Shared COGS table — used in onboarding step 3 and Settings COGS section.
// Renders inside a parent <Form>. Hidden inputs carry all variant data on submit.
// Props:
//   products:  [{ shopify_product_id, product_title, variants: [{ shopify_variant_id,
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

  // Products whose per-variant rows are expanded. Auto-expand when variants have
  // different costs (e.g. Shopify already has distinct costs per variant).
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

  // Apply one cost to every variant of a product (bulk input)
  const applyToAll = (product, val) => {
    setCosts(prev => {
      const next = { ...prev };
      for (const v of product.variants) next[v.shopify_variant_id] = val;
      return next;
    });
  };

  const updateOne = (variantId, val) =>
    setCosts(prev => ({ ...prev, [variantId]: val }));

  // If all variants of a product share the same cost, return it; otherwise ""
  const productCostValue = (product) => {
    const vals = product.variants.map(v => costs[v.shopify_variant_id] ?? "");
    return new Set(vals).size === 1 ? vals[0] : "";
  };

  const isMixed = (product) =>
    new Set(product.variants.map(v => costs[v.shopify_variant_id] ?? "")).size > 1;

  // Count products where at least one variant was pre-filled from Shopify (not from DB)
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
          const isExpanded  = expanded.has(product.shopify_product_id);
          const mixed       = isMixed(product);
          const bulkVal     = productCostValue(product);
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
                <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
                  <InlineStack gap="200" blockAlign="center">
                    <Text fontWeight="semibold" variant="bodyMd">
                      {product.product_title}
                    </Text>
                    {multiVariant && (
                      <Badge>
                        {product.variants.length} variants
                      </Badge>
                    )}
                    {anyShopifyCost && !multiVariant && (
                      <Badge tone="info">Pre-filled</Badge>
                    )}
                    {anyShopifyCost && multiVariant && !isExpanded && (
                      <Badge tone="info">Pre-filled</Badge>
                    )}
                  </InlineStack>

                  <InlineStack gap="300" blockAlign="center" wrap={false}>
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
                      <Button
                        variant="plain"
                        onClick={() => toggleExpanded(product.shopify_product_id)}
                      >
                        {isExpanded ? "Collapse" : "Per variant"}
                      </Button>
                    )}
                  </InlineStack>
                </InlineStack>

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
                            <InlineStack
                              key={v.shopify_variant_id}
                              align="space-between"
                              blockAlign="center"
                              gap="400"
                              wrap={false}
                            >
                              <InlineStack gap="200" blockAlign="center">
                                <Box paddingInlineStart="400">
                                  <Text variant="bodySm">{displayTitle}</Text>
                                </Box>
                                {v.sku && (
                                  <Text variant="bodySm" tone="subdued">
                                    {v.sku}
                                  </Text>
                                )}
                                {v.shopify_cost != null && (
                                  <Badge tone="info" size="small">
                                    Shopify: PKR {v.shopify_cost}
                                  </Badge>
                                )}
                              </InlineStack>
                              <div style={{ width: 160 }}>
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
                            </InlineStack>
                          );
                        })}
                      </BlockStack>
                    </Box>
                  </Collapsible>
                )}
              </BlockStack>

              {/* Hidden inputs — always present so every variant is submitted */}
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
