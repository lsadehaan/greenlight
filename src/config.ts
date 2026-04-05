import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl:
    process.env.DATABASE_URL || "postgresql://greenlight:greenlight@localhost:5432/greenlight",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  nodeEnv: process.env.NODE_ENV || "development",
  version: pkg.version,
  webhookSecret: process.env.WEBHOOK_SECRET || "greenlight-dev-secret",
};
