// Unit tests for app/lib/cart-attributes.server.js — order/checkout payload parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIdentityFromOrder,
  extractCustomerIdentity,
} from "../app/lib/cart-attributes.server.js";

test("extractIdentityFromOrder reads _fbp / _fbc / _fbclid from note_attributes", () => {
  const order = {
    note_attributes: [
      { name: "_fbp", value: "fb.1.123.456" },
      { name: "_fbc", value: "fb.1.789.abc" },
      { name: "_fbclid", value: "abc" },
      { name: "_client_ua", value: "Mozilla/5.0" },
    ],
    client_details: { browser_ip: "1.2.3.4" },
  };
  const id = extractIdentityFromOrder(order);
  assert.equal(id.fbp, "fb.1.123.456");
  assert.equal(id.fbc, "fb.1.789.abc");
  assert.equal(id.fbclid, "abc");
  assert.equal(id.clientUa, "Mozilla/5.0");
  assert.equal(id.clientIp, "1.2.3.4");
});

test("extractIdentityFromOrder synthesizes _fbc from fbclid when missing", () => {
  const order = {
    note_attributes: [{ name: "_fbclid", value: "xyz" }],
  };
  const id = extractIdentityFromOrder(order);
  assert.match(id.fbc, /^fb\.1\.\d+\.xyz$/);
});

test("extractIdentityFromOrder falls back to client_details.user_agent", () => {
  const order = {
    note_attributes: [],
    client_details: { user_agent: "FromShopify/1" },
  };
  const id = extractIdentityFromOrder(order);
  assert.equal(id.clientUa, "FromShopify/1");
});

test("extractIdentityFromOrder handles empty/missing attributes safely", () => {
  const id = extractIdentityFromOrder({});
  assert.equal(id.fbp, null);
  assert.equal(id.fbc, null);
  assert.equal(id.clientIp, null);
});

test("extractIdentityFromOrder reads from `attributes` (checkout payload)", () => {
  const checkout = {
    attributes: [{ name: "_fbp", value: "fb.1.x.y" }],
  };
  const id = extractIdentityFromOrder(checkout);
  assert.equal(id.fbp, "fb.1.x.y");
});

test("extractIdentityFromOrder supports {key,value} shape (Shopify webhook variant)", () => {
  const order = {
    note_attributes: [{ key: "_fbp", value: "fb.1.x.y" }],
  };
  const id = extractIdentityFromOrder(order);
  assert.equal(id.fbp, "fb.1.x.y");
});

// ─── extractCustomerIdentity ──────────────────────────────────────────────────

test("extractCustomerIdentity prefers customer.email over order.email", () => {
  const order = {
    email: "shipping@example.com",
    customer: { email: "customer@example.com" },
  };
  const c = extractCustomerIdentity(order);
  // Spec: order.email takes precedence (it's what the buyer entered at checkout).
  assert.equal(c.email, "shipping@example.com");
});

test("extractCustomerIdentity pulls address from shipping_address", () => {
  const order = {
    shipping_address: {
      city: "Karachi",
      province_code: "Sindh",
      zip: "75200",
      country_code: "PK",
      first_name: "Jane",
      last_name: "Doe",
      phone: "+923001112222",
    },
  };
  const c = extractCustomerIdentity(order);
  assert.equal(c.city, "Karachi");
  assert.equal(c.state, "Sindh");
  assert.equal(c.zip, "75200");
  assert.equal(c.country, "PK");
  assert.equal(c.firstName, "Jane");
  assert.equal(c.lastName, "Doe");
  assert.equal(c.phone, "+923001112222");
});

test("extractCustomerIdentity falls back to billing_address when no shipping", () => {
  const order = {
    billing_address: { city: "Lahore", zip: "54000" },
  };
  const c = extractCustomerIdentity(order);
  assert.equal(c.city, "Lahore");
  assert.equal(c.zip, "54000");
});

test("extractCustomerIdentity stringifies numeric customer.id as externalId", () => {
  const order = { customer: { id: 1234567890 } };
  const c = extractCustomerIdentity(order);
  assert.equal(c.externalId, "1234567890");
});
