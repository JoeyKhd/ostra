// Observations: facts the spike measured on the way that ostra should know, though they are not
// pass-bar criteria. They print after the criteria and never change a verdict.

import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "./generated/prisma/client.ts";
import type { RunContext } from "./kit.ts";

export const id = "O1";
export const title = "Prisma 7 + @prisma/adapter-pg writes a timestamptz shifted by the session's UTC offset";

const NAME = "o1_timestamptz";

const probe = async (ctx: RunContext, zone: string): Promise<number> => {
  const db = await ctx.cluster.createScenarioDatabase(`${NAME}_${zone.toLowerCase().replace(/[^a-z]/g, "")}`);
  try {
    await db.setTimezone(zone);
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.url, max: 1 }) });
    try {
      const written = new Date();
      await prisma.scheduleFire.create({
        data: { scheduleKey: "probe", variant: "probe", jobId: "probe", replicaId: "probe", jobCreated: written },
      });
      const rows = await db.query(
        "SELECT (extract(epoch from job_created) * 1000)::float8 AS ms FROM schedule_fire",
        [],
        z.object({ ms: z.number() }),
      );
      return Math.round((rows[0]?.ms ?? 0) - written.getTime());
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await db.close();
  }
};

export const run = async (ctx: RunContext): Promise<readonly string[]> => {
  // Zones are fixed, so the result does not depend on the machine's own time zone.
  const utc = await probe(ctx, "UTC");
  const kolkata = await probe(ctx, "Asia/Kolkata");
  const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(2)} h`;
  return [
    `a JS Date written through Prisma to a timestamptz column and read back with SQL: with the database session in UTC the stored instant is off by ${hours(utc)}; with it in Asia/Kolkata (UTC+5:30) it is off by ${hours(kolkata)}`,
    "reading the same row back through Prisma returns the original Date, so the shift is invisible inside Prisma and wrong everywhere else (pg-boss, SQL, other services)",
    "so: ostra's database must run with timezone UTC (database or role setting, or `options=-c TimeZone=UTC`), or its Prisma columns stay on Prisma's default timestamp(3); this harness sets UTC on every scenario database",
  ];
};
