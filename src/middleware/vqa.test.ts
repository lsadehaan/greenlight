import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import cors from "cors";
import helmet from "helmet";

function buildApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());

  app.get("/test", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/test", (req, res) => {
    res.json({ body: req.body });
  });

  // JSON parse error handler (same as index.ts)
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if ((err as any).type === "entity.parse.failed") {
        res.status(400).json({ error: "bad_request", message: "Invalid JSON" });
        return;
      }
      next(err);
    },
  );

  return app;
}

describe("CORS (#41)", () => {
  it("responds to OPTIONS preflight with CORS headers", async () => {
    const app = buildApp();
    const res = await request(app)
      .options("/test")
      .set("Origin", "https://example.com")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("includes CORS headers on normal requests", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://example.com");

    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toEqual({ ok: true });
  });
});

describe("JSON parse error (#42)", () => {
  it("returns 400 JSON on malformed request body", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .send("{invalid json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(res.body.message).toBe("Invalid JSON");
  });

  it("accepts valid JSON normally", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/test")
      .send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ hello: "world" });
  });
});

describe("Security headers (#43)", () => {
  it("sets helmet security headers", async () => {
    const app = buildApp();
    const res = await request(app).get("/test");

    // helmet removes X-Powered-By
    expect(res.headers["x-powered-by"]).toBeUndefined();
    // helmet sets various security headers
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
