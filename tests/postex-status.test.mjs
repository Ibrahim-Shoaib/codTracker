// Unit tests for app/lib/postex.server.js status mapping.
//
// Regression guard for the trendy-homes May 2026 corruption: PostEx returns
// the literal status string "Return In-Transit", which was missing from
// STRING_STATUS_MAP and therefore fell back to 0003/in-transit — forever,
// once the order aged out of the sync window. 13 real returns sat invisible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOrder } from "../app/lib/postex.server.js";

function flagsFor(status) {
  const row = mapOrder({ trackingNumber: "T1", transactionStatus: status }, "s1");
  return {
    is_delivered: row.is_delivered,
    is_returned: row.is_returned,
    is_in_transit: row.is_in_transit,
  };
}

test("Return In-Transit counts as returned (reversal charges already apply)", () => {
  assert.deepEqual(flagsFor("Return In-Transit"), {
    is_delivered: false, is_returned: true, is_in_transit: false,
  });
});

test("In Stock counts as in-transit (pre-dispatch, non-terminal)", () => {
  assert.deepEqual(flagsFor("In Stock"), {
    is_delivered: false, is_returned: false, is_in_transit: true,
  });
});

test("core statuses unchanged", () => {
  assert.deepEqual(flagsFor("Delivered"), { is_delivered: true,  is_returned: false, is_in_transit: false });
  assert.deepEqual(flagsFor("Return"),    { is_delivered: false, is_returned: true,  is_in_transit: false });
  assert.deepEqual(flagsFor("Booked"),    { is_delivered: false, is_returned: false, is_in_transit: true  });
  assert.deepEqual(flagsFor("Cancelled"), { is_delivered: false, is_returned: false, is_in_transit: false });
  // Unknown strings stay conservative: in-transit, not delivered/returned.
  assert.deepEqual(flagsFor("Some Future Status"), { is_delivered: false, is_returned: false, is_in_transit: true });
});

test("sync window stretches to oldest non-terminal order, capped at 90d", async () => {
  const { computeSyncWindowDays } = await import("../app/lib/sync.server.js");
  const now = Date.UTC(2026, 6, 10);
  const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();
  assert.equal(computeSyncWindowDays(null, now), 20);
  assert.equal(computeSyncWindowDays("not-a-date", now), 20);
  assert.equal(computeSyncWindowDays(daysAgo(5), now), 20);   // young → default
  assert.equal(computeSyncWindowDays(daysAgo(51), now), 52);  // stretch to cover
  assert.equal(computeSyncWindowDays(daysAgo(400), now), 90); // cap
});
