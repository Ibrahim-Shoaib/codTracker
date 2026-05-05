import { Suspense } from "react";
import { Await } from "@remix-run/react";
import { Badge, InlineStack } from "@shopify/polaris";
import PillSkeleton from "./PillSkeleton.jsx";
import { formatMoney } from "../lib/format.js";

// Two pills under the headline Sales number on each KPI card:
//   • Unfulfilled (yellow) — orders placed in this period that haven't
//     been shipped yet.
//   • In Transit (blue)    — pipeline value for non-terminal courier
//     orders (Booked, Out for Delivery, etc.). Rendered in store
//     currency.
//
// Props:
//   inTransitValue       number | null
//   unfulfilledPromise   Promise<{<period>:{count,value}}> | null
//   unfulfilledValue     {count, value} | null
//   period               'today' | 'yesterday' | 'mtd' | 'lastMonth'
//   currency             ISO 4217 code from stores.currency

const fmtPKR = (n, currency) => formatMoney(n, currency);

export default function PipelinePills({
  inTransitValue,
  unfulfilledPromise,
  unfulfilledValue,
  period,
  currency = "PKR",
}) {
  const inTransitNum = Number(inTransitValue ?? 0);

  return (
    <InlineStack gap="200" wrap>
      {unfulfilledPromise && (
        <Suspense fallback={<PillSkeleton />}>
          <Await resolve={unfulfilledPromise}>
            {(pipeline) => {
              const value = pipeline?.[period]?.value ?? 0;
              return (
                <Badge tone="attention">
                  {`${fmtPKR(value, currency)} · Unfulfilled`}
                </Badge>
              );
            }}
          </Await>
        </Suspense>
      )}
      {!unfulfilledPromise && unfulfilledValue && (
        <Badge tone="attention">
          {`${fmtPKR(unfulfilledValue.value ?? 0, currency)} · Unfulfilled`}
        </Badge>
      )}
      <Badge tone="info">
        {`${fmtPKR(inTransitNum, currency)} · In Transit`}
      </Badge>
    </InlineStack>
  );
}
