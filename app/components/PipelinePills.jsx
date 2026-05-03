import { Suspense } from "react";
import { Await } from "@remix-run/react";
import { Badge, InlineStack } from "@shopify/polaris";
import PillSkeleton from "./PillSkeleton.jsx";

// Two pills under the headline Sales number on each KPI card:
//   • Unfulfilled (yellow) — orders placed in this period that haven't
//     been shipped yet. Sourced two ways:
//       - Default range  → the deferred Shopify promise from the dashboard
//                          loader, bucketed by period.
//       - Custom range   → a direct {count,value} from /app/api/stats,
//                          which fetches Shopify (real) or the demo pool
//                          (demo) for that exact range.
//   • In Transit (blue)    — pipeline PKR for non-terminal courier orders
//     (Booked, Unbooked, Out for Delivery, Under Verification, Attempted).
//     Comes from the synchronous SQL stats — no skeleton needed.
//
// Props:
//   inTransitValue       number | null                     — from RPC
//   unfulfilledPromise   Promise<{<period>:{count,value}}> | null
//   unfulfilledValue     {count, value} | null              (direct path)
//   period               'today' | 'yesterday' | 'mtd' | 'lastMonth'
//
// Pass null for both unfulfilled props to suppress the pill entirely.

const fmtPKR = (n) => `PKR ${Math.round(Number(n)).toLocaleString()}`;

export default function PipelinePills({
  inTransitValue,
  unfulfilledPromise,
  unfulfilledValue,
  period,
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
                  {`${fmtPKR(value)} · Unfulfilled`}
                </Badge>
              );
            }}
          </Await>
        </Suspense>
      )}
      {!unfulfilledPromise && unfulfilledValue && (
        <Badge tone="attention">
          {`${fmtPKR(unfulfilledValue.value ?? 0)} · Unfulfilled`}
        </Badge>
      )}
      <Badge tone="info">
        {`${fmtPKR(inTransitNum)} · In Transit`}
      </Badge>
    </InlineStack>
  );
}
