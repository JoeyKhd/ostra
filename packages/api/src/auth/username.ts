import { usernameSchema } from "@ostra/domain";

// One username rule for the seeded admin's settings (the domain's schema) and the username plugin,
// so a name one accepts the other accepts too: lowercase letters, digits and inner hyphens, 2 to 39.

export const isValidUsername = (candidate: string): boolean => usernameSchema.safeParse(candidate).success;

export const usernamePluginOptions = {
  minUsernameLength: 2,
  maxUsernameLength: 39,
  usernameValidator: isValidUsername,
} as const;
