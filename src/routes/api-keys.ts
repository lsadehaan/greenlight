import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { hashApiKey } from "../middleware/auth.js";

export function createApiKeyRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "bad_request", message: "name is required" });
      return;
    }

    const plaintext = `gl_${randomBytes(32).toString("hex")}`;
    const keyHash = hashApiKey(plaintext);

    const apiKey = await prisma.apiKey.create({
      data: { keyHash, name: name.trim() },
    });

    res.status(201).json({
      id: apiKey.id,
      key: plaintext,
      name: apiKey.name,
      created_at: apiKey.createdAt,
    });
  });

  router.get("/", async (_req, res) => {
    const keys = await prisma.apiKey.findMany({
      select: { id: true, name: true, active: true, createdAt: true, revokedAt: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(
      keys.map((k) => ({
        id: k.id,
        name: k.name,
        active: k.active,
        created_at: k.createdAt,
        revoked_at: k.revokedAt,
      })),
    );
  });

  router.delete("/:id", async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "API key not found" });
      return;
    }

    await prisma.apiKey.update({
      where: { id },
      data: { active: false, revokedAt: new Date() },
    });

    res.status(204).end();
  });

  return router;
}
