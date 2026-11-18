"use client";

import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient, usernameClient } from "better-auth/client/plugins";

// better-auth's client (ADR 0003): sign-in by username or email, sign-out, and the device
// approval page (`/device`). Same origin, so no base URL.
export const authClient = createAuthClient({
  plugins: [usernameClient(), deviceAuthorizationClient()],
});
