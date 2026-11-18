import { createFirstAdminInputSchema } from "@ostra/domain";

// One username rule for the first-admin form (the domain's schema) and the username plugin, so a
// name one accepts the other accepts too: lowercase letters, digits and inner hyphens, 2 to 39.

const usernameRule = createFirstAdminInputSchema.shape.username;

export const isValidUsername = (candidate: string): boolean => usernameRule.safeParse(candidate).success;

export const usernamePluginOptions = {
  minUsernameLength: 2,
  maxUsernameLength: 39,
  usernameValidator: isValidUsername,
} as const;
