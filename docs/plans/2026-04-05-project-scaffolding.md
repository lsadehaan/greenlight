# Project Scaffolding, Docker Compose Stack, and Health Endpoint

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up the foundational project structure with TypeScript + Express + Prisma + BullMQ + PostgreSQL + Redis, Docker Compose stack, and a `/health` endpoint that reports connection status of all dependencies.

**Architecture:** Express API server with Prisma ORM for PostgreSQL, ioredis for Redis, all containerized via Docker Compose. Multi-stage Dockerfile for production builds under 200MB. Health endpoint checks both DB and Redis connectivity.

**Tech Stack:** Node.js 20, TypeScript (strict, ES2022), Express 4, Prisma, ioredis, Docker Compose, ESLint 9 (flat config), Prettier

---

### Task 1: Initialize Node.js project and TypeScript config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

**Step 1: Initialize package.json**

```bash
cd /home/ubuntu/greenlight
npm init -y
```

Then edit `package.json` to set:

```json
{
  "name": "greenlight",
  "version": "0.1.0",
  "description": "Open-source AI Approval and Compliance Layer for SMBs",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint . && prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "MIT",
  "private": true
}
```

**Step 2: Install core dependencies**

```bash
npm install express ioredis @prisma/client
npm install -D typescript @types/node @types/express tsx prisma vitest
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: initialize Node.js project with TypeScript config"
```

---

### Task 2: Set up ESLint + Prettier

**Files:**
- Create: `eslint.config.mjs`
- Create: `.prettierrc`
- Create: `.prettierignore`

**Step 1: Install ESLint and Prettier dependencies**

```bash
npm install -D eslint @eslint/js typescript-eslint prettier eslint-config-prettier
```

**Step 2: Create eslint.config.mjs**

```javascript
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  }
);
```

**Step 3: Create .prettierrc**

```json
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": false,
  "printWidth": 100,
  "tabWidth": 2
}
```

**Step 4: Create .prettierignore**

```
dist/
node_modules/
*.md
```

**Step 5: Run lint to verify config**

Run: `npm run lint`
Expected: Passes (no source files yet, so no warnings)

**Step 6: Commit**

```bash
git add eslint.config.mjs .prettierrc .prettierignore package.json package-lock.json
git commit -m "chore: set up ESLint 9 flat config + Prettier"
```

---

### Task 3: Create Express server with health endpoint

**Files:**
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `src/health.ts`

**Step 1: Create src/config.ts**

```typescript
export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL || "postgresql://greenlight:greenlight@localhost:5432/greenlight",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  nodeEnv: process.env.NODE_ENV || "development",
  version: process.env.npm_package_version || "0.1.0",
};
```

**Step 2: Create src/health.ts**

```typescript
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

export function createHealthRouter(prisma: PrismaClient, redis: Redis): Router {
  const router = Router();

  router.get("/health", async (_req: Request, res: Response) => {
    const startTime = process.uptime();

    let dbStatus = "connected";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = "disconnected";
    }

    let redisStatus = "connected";
    try {
      await redis.ping();
    } catch {
      redisStatus = "disconnected";
    }

    const status = dbStatus === "connected" && redisStatus === "connected" ? "healthy" : "unhealthy";
    const statusCode = status === "healthy" ? 200 : 503;

    res.status(statusCode).json({
      status,
      version: process.env.npm_package_version || "0.1.0",
      uptime_seconds: Math.floor(startTime),
      db: dbStatus,
      redis: redisStatus,
    });
  });

  return router;
}
```

**Step 3: Create src/index.ts**

```typescript
import express from "express";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { config } from "./config.js";
import { createHealthRouter } from "./health.js";

const app = express();
const prisma = new PrismaClient();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });

app.use(express.json());

app.use(createHealthRouter(prisma, redis));

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

async function start(): Promise<void> {
  try {
    await prisma.$connect();
    await redis.connect();
    app.listen(config.port, () => {
      console.log(`Greenlight API listening on port ${config.port}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
```

**Step 4: Initialize Prisma**

```bash
npx prisma init --datasource-provider postgresql
```

This creates `prisma/schema.prisma` and `.env`. Edit `prisma/schema.prisma` to just have the datasource (no models yet — issue #2 handles schema):

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Generate the Prisma client:

```bash
npx prisma generate
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Run lint + format**

Run: `npx prettier --write src/`
Run: `npm run lint`
Expected: PASS with zero warnings

**Step 7: Commit**

```bash
git add src/ prisma/ .env
git commit -m "feat: add Express server with health endpoint and Prisma + Redis clients"
```

Note: `.env` should be gitignored (Task 5 adds `.gitignore`). If `.env` has secrets, skip adding it. We'll address this in Task 5.

---

### Task 4: Write health endpoint tests

**Files:**
- Create: `src/health.test.ts`

**Step 1: Write the tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHealthRouter } from "./health.js";

function buildApp(dbOk: boolean, redisOk: boolean) {
  const prisma = {
    $queryRaw: dbOk ? vi.fn().mockResolvedValue([{ "?column?": 1 }]) : vi.fn().mockRejectedValue(new Error("db down")),
  } as any;

  const redis = {
    ping: redisOk ? vi.fn().mockResolvedValue("PONG") : vi.fn().mockRejectedValue(new Error("redis down")),
  } as any;

  const app = express();
  app.use(createHealthRouter(prisma, redis));
  return app;
}

describe("GET /health", () => {
  it("returns 200 and healthy when all services are connected", async () => {
    const app = buildApp(true, true);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.db).toBe("connected");
    expect(res.body.redis).toBe("connected");
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("uptime_seconds");
  });

  it("returns 503 when database is disconnected", async () => {
    const app = buildApp(false, true);
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.db).toBe("disconnected");
    expect(res.body.redis).toBe("connected");
  });

  it("returns 503 when redis is disconnected", async () => {
    const app = buildApp(true, false);
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.db).toBe("connected");
    expect(res.body.redis).toBe("disconnected");
  });

  it("returns 503 when both services are disconnected", async () => {
    const app = buildApp(false, false);
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.db).toBe("disconnected");
    expect(res.body.redis).toBe("disconnected");
  });
});
```

**Step 2: Install supertest**

```bash
npm install -D supertest @types/supertest
```

**Step 3: Run tests**

Run: `npm run test`
Expected: All 4 tests PASS

**Step 4: Commit**

```bash
git add src/health.test.ts package.json package-lock.json
git commit -m "test: add health endpoint unit tests"
```

---

### Task 5: Create .env.example, .gitignore, .dockerignore

**Files:**
- Create: `.env.example`
- Create: `.gitignore`
- Create: `.dockerignore`

**Step 1: Create .env.example**

```bash
# Database
DATABASE_URL=postgresql://greenlight:greenlight@localhost:5432/greenlight

# Redis
REDIS_URL=redis://localhost:6379

# Server
PORT=3000
NODE_ENV=development
```

**Step 2: Create .gitignore**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

**Step 3: Create .dockerignore**

```
node_modules/
dist/
.git/
.env
*.md
docs/
tests/
```

**Step 4: Commit**

```bash
git add .env.example .gitignore .dockerignore
git commit -m "chore: add .env.example, .gitignore, .dockerignore"
```

---

### Task 6: Create Dockerfile (multi-stage)

**Files:**
- Create: `Dockerfile`

**Step 1: Create Dockerfile**

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

**Step 2: Build image and check size**

```bash
docker build -t greenlight:test .
docker image ls greenlight:test
```
Expected: Image size < 200MB

**Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage production Dockerfile"
```

---

### Task 7: Create docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

**Step 1: Create docker-compose.yml**

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://greenlight:greenlight@postgres:5432/greenlight
      REDIS_URL: redis://redis:6379
      PORT: "3000"
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 5s

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: greenlight
      POSTGRES_PASSWORD: greenlight
      POSTGRES_DB: greenlight
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U greenlight"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

**Step 2: Test full stack**

```bash
docker compose up -d --build
sleep 5
curl -s http://localhost:3000/health | jq .
```

Expected output:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": ...,
  "db": "connected",
  "redis": "connected"
}
```

**Step 3: Check image size**

```bash
docker image ls | grep greenlight
```
Expected: < 200MB

**Step 4: Tear down**

```bash
docker compose down -v
```

**Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add Docker Compose stack with app, PostgreSQL, and Redis"
```

---

### Task 8: Final verification — all acceptance criteria

**Step 1: Run lint**

```bash
npm run lint
```
Expected: PASS, zero warnings

**Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: PASS

**Step 3: Run build**

```bash
npm run build
```
Expected: PASS, no errors

**Step 4: Run tests**

```bash
npm run test
```
Expected: All tests pass

**Step 5: Run full Docker stack**

```bash
docker compose up -d --build
sleep 5
curl -s http://localhost:3000/health | jq .
docker image ls | grep greenlight
docker compose down -v
```

Expected: Health returns 200/healthy, image < 200MB

**Step 6: Capture evidence for PR**

Save all command outputs for inclusion in PR description.
