import { z } from "zod";

// The account rules every side shares (F-002, Q54): the username rule, the password policy, and the
// default admin a fresh install seeds (F-001, the maintainer, 2026-11-19: "default setup user is
// demo@demo.com with password demo, unless specified otherwise in one of the environment
// variables").

/** Every account's username: lowercase letters, digits and inner hyphens, 2 to 39. */
export const usernameSchema = z
  .string()
  .min(2)
  .max(39)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and inner hyphens");

/** The password policy: better-auth enforces the same length on sign-up and every password change. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

/** An organization's name. */
export const organizationNameSchema = z.string().trim().min(1).max(128);

/**
 * The account a fresh install seeds when no `OSTRA_ADMIN_*` variable says otherwise. The default
 * password is under the policy's length on purpose: only the seed may store it, and the account
 * then must choose a new one at its first sign-in (unless `OSTRA_ALLOW_DEFAULT_PASSWORD` is on).
 */
export const defaultFirstAdmin = {
  email: "demo@demo.com",
  username: "demo",
  password: "demo",
  organizationName: "Demo",
} as const;
