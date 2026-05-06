/**
 * KRONOS — Zarządzanie otwartymi pozycjami
 *
 * Śledzi aktywne pozycje w pamięci + persystuje do JSON
 * żeby przeżyć restart bota.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const POSITIONS_FILE = resolve(import.meta.dirname, "..", "positions.json");

export interface Position {
  orderId:    string;
  market:     string;
  direction:  "UP" | "DOWN";
  side:       "YES" | "NO";
  tokenId:    string;
  price:      number;
  sizeUsd:    number;
  payout:     number;
  openedAt:   string;   // ISO timestamp
  expiresAt:  string;   // ISO timestamp (koniec okna)
  status:     "open" | "won" | "lost" | "cancelled";
}

// ── Persystencja ─────────────────────────────────────────────────────────

function load(): Position[] {
  if (!existsSync(POSITIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(POSITIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(positions: Position[]): void {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// ── API ───────────────────────────────────────────────────────────────────

export function getOpen(): Position[] {
  return load().filter(p => p.status === "open");
}

export function add(position: Position): void {
  const all = load();
  all.push(position);
  save(all);
}

export function close(orderId: string, status: "won" | "lost"): void {
  const all = load();
  const pos = all.find(p => p.orderId === orderId);
  if (pos) {
    pos.status = status;
    save(all);
  }
}

export function countOpen(): number {
  return getOpen().length;
}

export function summary(): void {
  const all = load();
  const won  = all.filter(p => p.status === "won").length;
  const lost = all.filter(p => p.status === "lost").length;
  const open = all.filter(p => p.status === "open").length;
  const totalWagered = all.filter(p => p.status !== "open")
    .reduce((s, p) => s + p.sizeUsd, 0);
  const totalWon = all.filter(p => p.status === "won")
    .reduce((s, p) => s + p.payout - p.sizeUsd, 0);
  const totalLost = all.filter(p => p.status === "lost")
    .reduce((s, p) => s + p.sizeUsd, 0);

  console.log(`\n  📊 POZYCJE: ${won}W / ${lost}L / ${open} OPEN`);
  console.log(`     Postawiono: $${totalWagered.toFixed(2)}`);
  console.log(`     Zysk:       +$${totalWon.toFixed(2)}`);
  console.log(`     Strata:     -$${totalLost.toFixed(2)}`);
  console.log(`     NET:        ${(totalWon - totalLost) >= 0 ? "+" : ""}$${(totalWon - totalLost).toFixed(2)}\n`);
}
