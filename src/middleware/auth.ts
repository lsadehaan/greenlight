import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function createAuthMiddleware(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized", message: "API key required" });
      return;
    }

    const token = header.slice(7);
    const keyHash = hashApiKey(token);

    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!apiKey || !apiKey.active) {
      res.status(401).json({ error: "unauthorized", message: "Invalid API key" });
      return;
    }

    req.apiKey = { id: apiKey.id, name: apiKey.name };
    next();
  };
}
