import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ejs from "ejs";
import type { PrismaClient } from "../generated/prisma/client.js";
import { hashApiKey } from "../middleware/auth.js";
import { computeSummary } from "./analytics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, "..", "views");

function renderPage(templateName: string, data: Record<string, unknown>): string {
  const layout = readFileSync(path.join(VIEWS_DIR, "layout.ejs"), "utf-8");
  const template = readFileSync(path.join(VIEWS_DIR, `${templateName}.ejs`), "utf-8");
  const body = ejs.render(template, data, { filename: path.join(VIEWS_DIR, `${templateName}.ejs`) });
  return ejs.render(layout, { ...data, body }, { filename: path.join(VIEWS_DIR, "layout.ejs") });
}

export function createDashboardRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Auth middleware
  router.use(async (req, res, next) => {
    const token = (req.query.token as string) || "";
    if (!token) {
      res.status(401).send("Access denied. Provide ?token=<api-key> to authenticate.");
      return;
    }
    const keyHash = hashApiKey(token);
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!apiKey || !apiKey.active) {
      res.status(401).send("Invalid or inactive API key.");
      return;
    }
    req.apiKey = { id: apiKey.id, name: apiKey.name };
    next();
  });

  // GET /dashboard
  router.get("/", async (req, res) => {
    const token = req.query.token as string;

    const [data, pendingCount] = await Promise.all([
      computeSummary(prisma),
      prisma.submission.count({ where: { status: "pending" } }),
    ]);

    const html = renderPage("dashboard", {
      title: "Dashboard",
      token,
      pendingCount,
      data,
    });
    res.type("html").send(html);
  });

  return router;
}
