import express from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { createHealthRouter } from "./health.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

const app = express();
app.use(express.json());
app.use(createHealthRouter(prisma, redis));

async function start(): Promise<void> {
  app.listen(config.port, () => {
    console.log(`Greenlight API listening on port ${config.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
