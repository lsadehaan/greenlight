import express from "express";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { createHealthRouter } from "./health.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createApiKeyRouter } from "./routes/api-keys.js";
import { createPolicyRouter } from "./routes/policies.js";
import { createSubmissionRouter } from "./routes/submissions.js";
import { createReviewRouter, createReviewActionsRouter } from "./routes/reviews.js";
import { createFeedbackRouter } from "./routes/feedback.js";
import { createAuditRouter } from "./routes/audit.js";
import { createGuardrailRouter } from "./routes/guardrails.js";
import { createWebhookQueue, createWebhookWorker } from "./workers/webhook.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
const webhookQueue = createWebhookQueue(config.redisUrl);

const app = express();
app.use(express.json());

// Public routes (no auth)
app.use(createHealthRouter(prisma, redis));
app.use("/api/v1/review-actions", createReviewActionsRouter(prisma, webhookQueue));

// Auth middleware for all /api/v1/* routes
const auth = createAuthMiddleware(prisma);
app.use("/api/v1", auth);

// Authenticated routes
app.use("/api/v1/api-keys", createApiKeyRouter(prisma));
app.use("/api/v1/policies", createPolicyRouter(prisma));
app.use("/api/v1/submissions", createSubmissionRouter(prisma, webhookQueue));
app.use("/api/v1/submissions", createReviewRouter(prisma, webhookQueue));
app.use("/api/v1/submissions", createFeedbackRouter(prisma));
app.use("/api/v1/audit", createAuditRouter(prisma));
app.use("/api/v1/guardrails", createGuardrailRouter(prisma));

async function start(): Promise<void> {
  const worker = createWebhookWorker(prisma, config.redisUrl);
  console.log(`Webhook worker started (queue: ${worker.name})`);

  app.listen(config.port, () => {
    console.log(`Greenlight API listening on port ${config.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
