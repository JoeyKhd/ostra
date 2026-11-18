import { taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { openStream } from "../stream/subscribe.ts";
import { memberProcedure, router } from "../trpc/init.ts";

// ADR 0035, ticket 33: one subscription over SSE per tab. It carries the organization's change
// notices and, with a `taskId`, that task's committed events and live text. `lastEventId` is what the
// client's link sends when it reconnects; `afterSeq` is where the first page of history ended.
export const streamRouter = router({
  subscribe: memberProcedure
    .input(
      z.strictObject({
        taskId: taskIdSchema.optional(),
        afterSeq: z.number().int().nonnegative().optional(),
        lastEventId: z.string().nullish(),
      }),
    )
    .subscription(({ ctx, input, signal }) => openStream(ctx, input, signal)),
});
