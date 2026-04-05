import { randomBytes } from "node:crypto";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashApiKey } from "../src/middleware/auth.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const name = process.argv[2];
if (!name) {
  console.error("Usage: npx tsx scripts/create-api-key.ts <key-name>");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const plaintext = `gl_${randomBytes(32).toString("hex")}`;
const keyHash = hashApiKey(plaintext);

try {
  const apiKey = await prisma.apiKey.create({
    data: { keyHash, name },
  });
  console.log(`Created API key "${apiKey.name}" (id: ${apiKey.id})`);
  console.log(`Key: ${plaintext}`);
  console.log("\nSave this key — it cannot be retrieved again.");
} finally {
  await prisma.$disconnect();
  await pool.end();
}
