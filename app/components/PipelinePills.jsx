import { Suspense } from "react";
import { Await } from "@remix-run/react";
import { Badge, InlineStack } from "@shopify/polaris";
import PillSkeleton from "./PillSkeleton.jsx";

// Two pills under the headline Sales number on each KPI card:
//   • Unfulfilled (yellow) — Shopify orders placed in this period that
//     haven't been shipped yet. Suspends on the deferred Shopify promise.
//   • In Transit (blue)    — pipeline PKR for non-terminal courier orders
//     (Booked, Unbooked, Out for Delivery, Under Verification, Attempted).
//     Comes from the synchronous SQL stats — no skeleton needed.
//
// Props:
//   inTransitValue       number | null                     — from RPC
//   unfulfilledPromise   Promise<{<period>:{count,value}}> | null
//   period               'today' | 'yesterday' | 'mtd' | 'lastMonth'
//
// Pass a null `unfulfilledPromise` to suppress the Unfulfilled pill (e.g.
// when the user has changed the card's date range — the default-range
// promise no longer matches the displayed period).

const fmtPKR = (n) => `PKR ${Math.round(Number(n)).toLocaleString()}`;

export default function PipelinePills({ inTransitValue, unfulfilledPromise, period }) {
  const inTransitNum = Number(inTransitValue ?? 0);

  return (
    <InlineStack gap="200" wrap>
      {unfulfilledPromise && (
        <Suspense fallback={<PillSkeleton />}>
          <Await resolve={unfulfilledPromise}>
            {(pipeline) => {
              const bucket = pipeline?.[period];
              if (!bucket || bucket.value <= 0) return null;
              return (
                <Badge tone="warning">
                  {`${fmtPKR(bucket.value)} · Unfulfilled`}
                </Badge>
              );
            }}
          </Await>
        </Suspense>
      )}
      {inTransitNum > 0 && (
        <Badge tone="info">
          {`${fmtPKR(inTransitNum)} · In Transit`}
        </Badge>
      )}
    </InlineStack>
  );
}
