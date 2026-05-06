/**
 * KRONOS SCANNER — init-db.ts
 * 
 * Initializes the SQLite database from schema.sql.
 * Run once: `pnpm run init-db`
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

const DB_PATH = resolve(import.meta.dirname, "..", "kronos.db");
const SCHEMA_PATH = resolve(import.meta.dirname, "..", "schema.sql");

console.log("🗄️  Initializing SQLite database...");
console.log(`   Path: ${DB_PATH}`);

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Read and execute schema
const schema = readFileSync(SCHEMA_PATH, "utf-8");
db.exec(schema);

// Verify tables
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];

console.log(`   Tables created: ${tables.map((t) => t.name).join(", ")}`);
console.log("✅ Database ready.\n");

db.close();
