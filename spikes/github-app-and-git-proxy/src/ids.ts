import { z } from 'zod';

// Branded IDs: a bare string never stands in for one of these.

export const TaskIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a task ID is lowercase letters, digits and dashes')
  .brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;

// "owner/name", as GitHub spells a repository.
export const RepoSlugSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/, 'a repo is owner/name')
  .refine((s) => !s.endsWith('.git'), 'a repo slug has no .git suffix')
  .brand<'RepoSlug'>();
export type RepoSlug = z.infer<typeof RepoSlugSchema>;
