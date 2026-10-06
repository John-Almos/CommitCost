import { createClient, type PrismaClient } from "@commitcost/db";

// One client per server process (Next dev reloads modules on change).
const g = globalThis as unknown as { __commitcostDb?: PrismaClient };
export const db: PrismaClient = g.__commitcostDb ?? (g.__commitcostDb = createClient());
