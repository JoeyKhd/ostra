// The prompt a task starts with: the ticket, in a short frame. A real task's
// prompt carries more (project memory, the repository's conventions: ADR 0044);
// this is the least ostra would send, and the same for every run.

import { ticketKey, type Ticket } from "../tickets/schema.ts";

export const buildPrompt = (ticket: Ticket, branch: string): string =>
  `You are working on ticket ${ticketKey(ticket.id)} in the calc repository, which is checked out in your current directory on the branch \`${branch}\`.

# ${ticketKey(ticket.id)}: ${ticket.title}

${ticket.body}

Make the change the ticket asks for. Read the README first for the conventions, and run the tests (\`npm test\`) before you finish. Do not commit and do not push: the changes you leave in the working tree become the pull request. When you are done, reply with a short summary of the change, written for the pull request description.`;
