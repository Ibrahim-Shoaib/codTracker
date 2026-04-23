import { createCookieSessionStorage } from "@remix-run/node";

// Short-lived session for Meta OAuth state and pending token data.
// Stored in an httpOnly cookie; cleared after account selection is saved.
export const metaOAuthSession = createCookieSessionStorage({
  cookie: {
    name: "meta_oauth",
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 600, // 10 minutes — OAuth round-trip
    secrets: [process.env.SESSION_SECRET],
  },
});
