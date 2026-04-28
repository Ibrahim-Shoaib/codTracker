const BASE_URL = 'https://api.postex.pk/services/integration/api/order';

const DELIVERED_CODES  = new Set(['0005']);
const RETURNED_CODES   = new Set(['0002', '0006', '0007']);
// Terminal-but-not-delivered statuses: customer cancellation, never booked,
// or transferred away. Carried as is_in_transit=false so they don't pollute
// the in-transit count, but is_delivered/is_returned are also false so they
// don't count toward sales or returns either.
const CANCELLED_CODES  = new Set(['0009', '0010', '0011']);

// Fallback map when transactionStatusHistory is missing or empty.
// Live data confirmed: the list-orders API never returns transactionStatusHistory,
// so this map is the primary (and only) status resolution path for all synced orders.
// Actual API values observed: 'Delivered', 'Return', 'Booked', 'Cancelled', 'Under Verification',
// plus 'Unbooked' and 'Transferred' seen in the trendy-homes-pk dataset.
const STRING_STATUS_MAP = {
  'Delivered':             '0005',
  'Return':                '0002', // actual API value — NOT 'Returned'
  'Returned':              '0002', // kept as safety fallback
  'Booked':                '0003',
  'Out For Delivery':      '0004',
  'Attempted':             '0013',
  'Under Verification':    '0008', // actual API value for 'Delivery Under Review'
  'Delivery Under Review': '0008', // kept as safety fallback
  'Cancelled':             '0009',
  'Unbooked':              '0010',
  'Transferred':           '0011',
};

function resolveStatusCode(raw) {
  const history = raw.transactionStatusHistory;
  if (Array.isArray(history) && history.length > 0) {
    return history[history.length - 1].transactionStatusMessageCode || '0003';
  }
  return STRING_STATUS_MAP[raw.transactionStatus] || '0003';
}

function statusFlags(code) {
  if (DELIVERED_CODES.has(code))  return { is_delivered: true,  is_returned: false, is_in_transit: false };
  if (RETURNED_CODES.has(code))   return { is_delivered: false, is_returned: true,  is_in_transit: false };
  if (CANCELLED_CODES.has(code))  return { is_delivered: false, is_returned: false, is_in_transit: false };
  return                                  { is_delivered: false, is_returned: false, is_in_transit: true  };
}

// GET /v1/get-all-order — returns flat order objects or throws.
// Verified param names: orderStatusId (camelCase), startDate/endDate (not fromDate/toDate).
// The API may wrap each order in { trackingResponse: {...}, trackingNumber, message } (same
// envelope as the bulk-tracking endpoint). Extract trackingResponse when present so mapOrder
// always receives a flat order object regardless of which envelope format the API returns.
export async function fetchOrders(token, startDate, endDate) {
  const url = `${BASE_URL}/v1/get-all-order?orderStatusId=0&startDate=${startDate}&endDate=${endDate}`;
  const res = await fetch(url, { headers: { token } });
  if (!res.ok) throw new Error(`PostEx fetchOrders failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const dist = data.dist || [];
  return dist.map(item => item.trackingResponse ?? item);
}

// GET /v2/get-operational-city — 200 = valid token
export async function validateToken(token) {
  const res = await fetch(`${BASE_URL}/v2/get-operational-city`, { headers: { token } });
  return res.ok;
}

// Normalizes one raw PostEx order into the DB row shape
export function mapOrder(raw, storeId) {
  const statusCode = resolveStatusCode(raw);
  return {
    store_id:           storeId,
    tracking_number:    raw.trackingNumber,
    order_ref_number:   raw.orderRefNumber?.replace(/^#/, '') ?? null,
    transaction_status: raw.transactionStatus ?? null,
    invoice_payment:    Number(raw.invoicePayment) || 0,
    transaction_fee:    Number(raw.transactionFee) || 0,
    transaction_tax:    Number(raw.transactionTax) || 0,
    reversal_fee:       Number(raw.reversalFee)    || 0,
    reversal_tax:       Number(raw.reversalTax)    || 0,
    items:              Number(raw.items)           || 1,
    city_name:          raw.cityName     ?? null,
    customer_name:      raw.customerName ?? null,
    order_detail:       raw.orderDetail  ?? null,
    transaction_date:   raw.transactionDate ?? null,
    updated_at:         new Date().toISOString(),
    ...statusFlags(statusCode),
  };
}
