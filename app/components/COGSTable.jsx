import { useState } from "react";
import { DataTable, TextField, Text } from "@shopify/polaris";

// Shared COGS table — used in onboarding step 3 and Settings COGS section.
// Renders inside a parent <Form>. All inputs submit with the parent form.
// Props:
//   variants:  [{ shopify_variant_id, shopify_product_id, sku, product_title, variant_title }]
//   costsMap:  { [shopify_variant_id]: unit_cost }
export default function COGSTable({ variants, costsMap }) {
  const [costs, setCosts] = useState(() => {
    const initial = {};
    for (const v of variants) {
      initial[v.shopify_variant_id] = String(costsMap[v.shopify_variant_id] ?? "");
    }
    return initial;
  });

  const filledCount = Object.values(costs).filter(v => Number(v) > 0).length;

  if (variants.length === 0) {
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        No products found in your Shopify store.
      </Text>
    );
  }

  const rows = variants.map(v => [
    v.product_title ?? "—",
    v.variant_title && v.variant_title !== "Default Title" ? v.variant_title : "Default",
    v.sku || "—",
    // Hidden metadata fields + visible cost input — all inside the parent form
    <>
      <input type="hidden" name={`product_${v.shopify_variant_id}`} value={v.shopify_product_id ?? ""} />
      <input type="hidden" name={`sku_${v.shopify_variant_id}`} value={v.sku ?? ""} />
      <input type="hidden" name={`ptitle_${v.shopify_variant_id}`} value={v.product_title ?? ""} />
      <input type="hidden" name={`vtitle_${v.shopify_variant_id}`} value={v.variant_title ?? ""} />
      <TextField
        label="Unit cost"
        labelHidden
        name={`cost_${v.shopify_variant_id}`}
        value={costs[v.shopify_variant_id] ?? ""}
        onChange={(val) => setCosts(c => ({ ...c, [v.shopify_variant_id]: val }))}
        type="number"
        min="0"
        autoComplete="off"
        prefix="PKR"
      />
    </>,
  ]);

  return (
    <DataTable
      columnContentTypes={["text", "text", "text", "text"]}
      headings={["Product", "Variant", "SKU", "Unit Cost (PKR)"]}
      rows={rows}
      footerContent={`${filledCount} of ${variants.length} variants have costs entered`}
    />
  );
}
