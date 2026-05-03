import { createCookieSessionStorage } from "@remix-run/node";

// Short-lived session for the Pixel Tracking OAuth round-trip (FBL4B flow).
// Distinct cookie from `meta_oauth` so the older ads_read flow and the new
// Pixel Tracking flow can run independently without stomping on each other.
export const metaPixelOAuthSession = createCookieSessionStorage({
  cookie: {
    name: "meta_pixel_oauth",
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 600, // 10 minutes — OAuth round-trip
    secrets: [process.env.SESSION_SECRET],
  },
});
