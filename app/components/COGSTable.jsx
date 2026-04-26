import { useEffect, useMemo, useState } from "react";
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
// Renders inside a parent <Form>. Hidden inputs carry variant data on submit,
// but ONLY for rows whose value differs from the saved baseline (costsMap).
// This makes the form submission a clean diff: nothing posts unless changed.
//
// Props:
//   products:            [{ shopify_product_id, product_title, image_url, variants: [...] }]
//   costsMap:            { [shopify_variant_id]: unit_cost } — saved baseline from DB
//   onDirtyCountChange:  optional (count: number) => void, called whenever the
//                        number of dirty rows changes. Parent uses this to
//                        drive a SaveBar.
/**
 * @param {Object} props
 * @param {Array<any>} props.products
 * @param {Record<string, number>} props.costsMap
 * @param {(count: number) => void} [props.onDirtyCountChange]
 */
export default function COGSTable({ products, costsMap, onDirtyCountChange }) {
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

  // Returns true when this variant's current value differs from the saved
  // baseline. Numeric compare so trailing zeros / "1860" vs 1860 don't show
  // as dirty. costsMap[vid] === undefined means "no saved cost" — entering
  // anything > 0 makes the row dirty; staying empty/0 leaves it pristine.
  const isVariantDirty = (vid) => {
    const cur  = Number(costs[vid] ?? 0);
    const base = Number(costsMap[vid] ?? 0);
    return cur !== base;
  };

  const dirtyCount = useMemo(() => {
    let n = 0;
    for (const product of products) {
      for (const v of product.variants) {
        if (isVariantDirty(v.shopify_variant_id)) n++;
      }
    }
    return n;
    // costsMap is stable across the lifetime of this component (parent
    // re-mounts via key={} on Discard), so we only depend on costs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costs]);

  useEffect(() => {
    onDirtyCountChange?.(dirtyCount);
  }, [dirtyCount, onDirtyCountChange]);

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

  // True when any variant under this product is dirty. Used to show a
  // single "Modified" badge on the product header rather than per-variant
  // when the product is collapsed.
  const isProductDirty = (product) =>
    product.variants.some(v => isVariantDirty(v.shopify_variant_id));

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
          const productDirty = isProductDirty(product);

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
                      {(multiVariant || anyShopifyCost || productDirty) && (
                        <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
                          {multiVariant && (
                            <Badge>{product.variants.length} variants</Badge>
                          )}
                          {anyShopifyCost && (
                            <Badge tone="info">Pre-filled</Badge>
                          )}
                          {productDirty && (
                            <Badge tone="attention">Modified</Badge>
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
                          const variantDirty = isVariantDirty(v.shopify_variant_id);
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
                              {/* Left: variant title + SKU (truncates) + badges */}
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1 }}>
                                  <Text variant="bodySm" as="span">{displayTitle}</Text>
                                  {v.sku && (
                                    <Text variant="bodySm" tone="subdued" as="span">
                                      {" · "}{v.sku}
                                    </Text>
                                  )}
                                </div>
                                {variantDirty && (
                                  <div style={{ flexShrink: 0 }}>
                                    <Badge tone="attention" size="small">Modified</Badge>
                                  </div>
                                )}
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

              {/* Hidden inputs — only rendered for variants whose current value
                  differs from the saved baseline. The action handler then
                  receives a clean diff: nothing else gets a spurious
                  updated_at touch. */}
              {product.variants.map((v) =>
                isVariantDirty(v.shopify_variant_id) ? (
                  <span key={v.shopify_variant_id}>
                    <input type="hidden" name={`cost_${v.shopify_variant_id}`}    value={costs[v.shopify_variant_id] ?? "0"} />
                    <input type="hidden" name={`product_${v.shopify_variant_id}`} value={v.shopify_product_id} />
                    <input type="hidden" name={`sku_${v.shopify_variant_id}`}     value={v.sku} />
                    <input type="hidden" name={`ptitle_${v.shopify_variant_id}`}  value={v.product_title} />
                    <input type="hidden" name={`vtitle_${v.shopify_variant_id}`}  value={v.variant_title} />
                  </span>
                ) : null
              )}
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
