import { useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Modal,
  DataTable,
  Spinner,
  BlockStack,
  InlineStack,
  Button,
  Text,
} from "@shopify/polaris";

const STATUS_LABELS = {
  delivered: "Delivered Orders",
  returned: "Returned Orders",
  in_transit: "In-Transit Orders",
  all: "All Orders",
};

// Props:
//   fromDate     'YYYY-MM-DD' PKT
//   toDate       'YYYY-MM-DD' PKT
//   statusFilter 'delivered'|'returned'|'in_transit'|'all'
//   open         boolean
//   onClose      () => void
export default function DrillDownTable({ fromDate, toDate, statusFilter, open, onClose }) {
  const fetcher = useFetcher();
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (open && fromDate && toDate) {
      fetcher.load(
        `/app/api/orders?fromDate=${fromDate}&toDate=${toDate}&statusFilter=${statusFilter}&offset=${offset}`
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fromDate, toDate, statusFilter, offset]);

  // Reset to page 0 when filter/dates change
  useEffect(() => {
    setOffset(0);
  }, [fromDate, toDate, statusFilter]);

  const orders = fetcher.data?.orders ?? [];
  const hasMore = fetcher.data?.hasMore ?? false;
  const loading = fetcher.state !== "idle";

  const rows = orders.map((o) => [
    o.tracking_number ?? "—",
    o.order_ref_number ?? "—",
    o.customer_name ?? "—",
    o.city_name ?? "—",
    o.transaction_date
      ? new Date(o.transaction_date).toLocaleDateString("en-PK", {
          day: "numeric",
          month: "short",
        })
      : "—",
    o.invoice_payment != null
      ? `PKR ${Math.round(o.invoice_payment).toLocaleString()}`
      : "—",
    o.delivery_cost != null
      ? `PKR ${Math.round(o.delivery_cost).toLocaleString()}`
      : "—",
    o.reversal_cost != null
      ? `PKR ${Math.round(o.reversal_cost).toLocaleString()}`
      : "—",
    o.cogs_total != null
      ? `PKR ${Math.round(o.cogs_total).toLocaleString()}`
      : "—",
    o.transaction_status ?? "—",
    String(o.items ?? 1),
    o.cogs_matched ? "✓" : "✗",
  ]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={STATUS_LABELS[statusFilter] ?? "Orders"}
      large
    >
      <Modal.Section>
        {loading ? (
          <BlockStack align="center" inlineAlign="center">
            <Spinner size="large" />
          </BlockStack>
        ) : orders.length === 0 ? (
          <Text as="p" tone="subdued">
            No orders found for this filter.
          </Text>
        ) : (
          <BlockStack gap="400">
            <DataTable
              columnContentTypes={[
                "text","text","text","text","text",
                "text","text","text","text",
                "text","numeric","text",
              ]}
              headings={[
                "Tracking #","Order Ref","Customer","City","Date",
                "Invoice (PKR)","Delivery Cost","Reversal Cost","COGS",
                "Status","Items","COGS",
              ]}
              rows={rows}
            />
            {(offset > 0 || hasMore) && (
              <InlineStack gap="200" align="center">
                <Button
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous
                </Button>
                <Text as="span" tone="subdued">
                  Showing {offset + 1}–{offset + orders.length}
                </Text>
                <Button
                  disabled={!hasMore}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
