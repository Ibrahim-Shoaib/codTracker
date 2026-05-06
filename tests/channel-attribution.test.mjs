import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUrlChannel } from "../app/lib/channel-attribution.server.js";

test("classifyUrlChannel: facebook ad — fbclid + utm_source=facebook", () => {
  const url =
    "https://thetrendyhome.pk/products/x?fbclid=IwZXh0bgNh&utm_source=facebook&utm_medium=paid&utm_campaign=120249346068950242";
  const r = classifyUrlChannel(url);
  assert.equal(r.channel, "facebook_ads");
  assert.equal(r.utmSource, "facebook");
  assert.equal(r.utmMedium, "paid");
  assert.equal(r.utmCampaign, "120249346068950242");
});

test("classifyUrlChannel: instagram ad — fbclid + utm_source=instagram", () => {
  const r = classifyUrlChannel(
    "https://thetrendyhome.pk/?fbclid=IwZ&utm_source=instagram&utm_medium=paid"
  );
  assert.equal(r.channel, "instagram_ads");
  assert.equal(r.utmSource, "instagram");
});

test("classifyUrlChannel: facebook ad — fbclid only, no utm", () => {
  // fbclid alone is enough to credit as paid Meta — defaults to facebook_ads
  // when utm_source is missing.
  const r = classifyUrlChannel(
    "https://thetrendyhome.pk/?fbclid=IwZXh0bgNhZW0BMABh"
  );
  assert.equal(r.channel, "facebook_ads");
  assert.equal(r.utmSource, null);
});

test("classifyUrlChannel: direct — no fbclid, no utm", () => {
  const r = classifyUrlChannel("https://thetrendyhome.pk/");
  assert.equal(r.channel, "direct_organic");
});

test("classifyUrlChannel: organic facebook share — utm_source=facebook but NO fbclid → direct_organic", () => {
  // Without fbclid, we cannot distinguish a paid click from an organic
  // share that someone tagged with utm_source=facebook. Bucket as organic
  // to avoid inflating ad attribution.
  const r = classifyUrlChannel(
    "https://thetrendyhome.pk/?utm_source=facebook&utm_medium=social"
  );
  assert.equal(r.channel, "direct_organic");
  assert.equal(r.utmSource, "facebook");
});

test("classifyUrlChannel: google search — utm_source=google → direct_organic", () => {
  const r = classifyUrlChannel(
    "https://thetrendyhome.pk/?utm_source=google&utm_medium=cpc"
  );
  assert.equal(r.channel, "direct_organic");
  assert.equal(r.utmSource, "google");
});

test("classifyUrlChannel: malformed URL → direct_organic with nulls", () => {
  const r = classifyUrlChannel("not a url");
  // URL constructor accepts any string with the "https://example.com"
  // base — "not a url" parses as a relative path. Still no fbclid →
  // direct_organic.
  assert.equal(r.channel, "direct_organic");
});

test("classifyUrlChannel: null input → direct_organic with nulls", () => {
  const r = classifyUrlChannel(null);
  assert.equal(r.channel, "direct_organic");
  assert.equal(r.utmSource, null);
  assert.equal(r.firstTouchUrl, null);
});

test("classifyUrlChannel: utmSource case-folded, utmCampaign preserved", () => {
  const r = classifyUrlChannel(
    "https://x.com/?fbclid=Iw&utm_source=Facebook&utm_campaign=Spring_Sale_2026"
  );
  assert.equal(r.utmSource, "facebook"); // lowercased
  assert.equal(r.utmCampaign, "Spring_Sale_2026"); // case preserved
  assert.equal(r.channel, "facebook_ads");
});

test("classifyUrlChannel: very long URL truncated to 500 chars", () => {
  const longUrl = "https://x.com/?fbclid=Iw&q=" + "x".repeat(1000);
  const r = classifyUrlChannel(longUrl);
  assert.equal(r.firstTouchUrl.length, 500);
  assert.equal(r.channel, "facebook_ads");
});
