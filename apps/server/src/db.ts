import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  LIVE_STATUSES,
  type AccountDetailView,
  type Approval,
  type ApprovalStatus,
  type CallOutcome,
  type CallPlan,
  type CallRecord,
  type CallStatus,
  type Playbook,
  type Profile,
  type Speaker,
  type TranscriptEntry,
} from "@ai-caller/shared";
import { maskValue, type Cipher } from "./crypto.js";

export const DEFAULT_USER = "local";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  callback_phone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, key)
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS calls_by_user ON calls(user_id, created_at);
CREATE TABLE IF NOT EXISTS transcript_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_by_call ON transcript_entries(call_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbooks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_key TEXT NOT NULL,
  company TEXT NOT NULL,
  menu_paths_json TEXT NOT NULL,
  tactics_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, company_key)
);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(user_id, key)
);
`;

type Row = Record<string, SQLInputValue>;
const now = () => new Date().toISOString();
export const companyKey = (company: string) => company.trim().toLowerCase().replace(/\s+/g, " ");

export interface AuditEvent {
  id: number;
  callId: string | null;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string, readonly cipher: Cipher) {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    this.db = new DatabaseSync(path.join(dataDir, "aicaller.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").run(DEFAULT_USER, now());
  }

  close() {
    this.db.close();
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // Profile and stored details
  getProfile(userId: string): Profile {
    const r = this.get("SELECT name, callback_phone FROM users WHERE id = ?", userId);
    return { name: String(r?.name ?? ""), callbackPhone: String(r?.callback_phone ?? "") };
  }
  updateProfile(userId: string, p: Partial<Profile>): Profile {
    if (p.name !== undefined) this.run("UPDATE users SET name = ? WHERE id = ?", p.name, userId);
    if (p.callbackPhone !== undefined) this.run("UPDATE users SET callback_phone = ? WHERE id = ?", p.callbackPhone, userId);
    return this.getProfile(userId);
  }
  listDetails(userId: string): AccountDetailView[] {
    return this.all("SELECT key, value_enc, created_at FROM account_details WHERE user_id = ? ORDER BY key", userId).map((r) => ({
      key: String(r.key),
      masked: maskValue(this.cipher.decrypt(String(r.value_enc))),
      createdAt: String(r.created_at),
    }));
  }
  detailKeys(userId: string): string[] {
    return this.all("SELECT key FROM account_details WHERE user_id = ? ORDER BY key", userId).map((r) => String(r.key));
  }
  setDetail(userId: string, key: string, value: string) {
    this.run(
      `INSERT INTO account_details (user_id, key, value_enc, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value_enc = excluded.value_enc`,
      userId,
      key,
      this.cipher.encrypt(value),
      now(),
    );
  }
  deleteDetail(userId: string, key: string): boolean {
    return Number(this.run("DELETE FROM account_details WHERE user_id = ? AND key = ?", userId, key).changes) > 0;
  }
  getDetailValue(userId: string, key: string): string | null {
    const r = this.get("SELECT value_enc FROM account_details WHERE user_id = ? AND key = ?", userId, key);
    return r ? this.cipher.decrypt(String(r.value_enc)) : null;
  }

  // Calls
  private toCall(r: Row): CallRecord {
    return {
      id: String(r.id),
      status: r.status as CallStatus,
      plan: JSON.parse(String(r.plan_json)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      endedAt: r.ended_at == null ? null : String(r.ended_at),
      outcome: r.outcome_json == null ? null : JSON.parse(String(r.outcome_json)),
    };
  }
  createCall(userId: string, plan: CallPlan): CallRecord {
    const id = randomUUID();
    const t = now();
    this.run(
      "INSERT INTO calls (id, user_id, status, plan_json, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)",
      id,
      userId,
      JSON.stringify(plan),
      t,
      t,
    );
    return this.getCall(userId, id)!;
  }
  getCall(userId: string, id: string): CallRecord | null {
    const r = this.get("SELECT * FROM calls WHERE id = ? AND user_id = ?", id, userId);
    return r ? this.toCall(r) : null;
  }
  listCalls(userId: string): CallRecord[] {
    return this.all("SELECT * FROM calls WHERE user_id = ? ORDER BY created_at DESC LIMIT 200", userId).map((r) => this.toCall(r));
  }
  updatePlan(userId: string, id: string, plan: CallPlan) {
    this.run("UPDATE calls SET plan_json = ?, updated_at = ? WHERE id = ? AND user_id = ?", JSON.stringify(plan), now(), id, userId);
  }
  setStatus(id: string, status: CallStatus) {
    const ended = ["transferred", "completed", "failed", "canceled"].includes(status);
    this.run(
      "UPDATE calls SET status = ?, updated_at = ?, ended_at = CASE WHEN ? THEN COALESCE(ended_at, ?) ELSE ended_at END WHERE id = ?",
      status,
      now(),
      ended ? 1 : 0,
      now(),
      id,
    );
  }
  setOutcome(id: string, outcome: CallOutcome) {
    this.run("UPDATE calls SET outcome_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(outcome), now(), id);
  }
  countLiveCalls(userId: string): number {
    const marks = LIVE_STATUSES.map(() => "?").join(",");
    return Number(this.get(`SELECT COUNT(*) AS n FROM calls WHERE user_id = ? AND status IN (${marks})`, userId, ...LIVE_STATUSES)?.n ?? 0);
  }
  /** Calls left in a live status by a previous run cannot continue; mark them failed. */
  failStaleLiveCalls(): number {
    const marks = LIVE_STATUSES.map(() => "?").join(",");
    const t = now();
    this.run(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'`, t);
    return Number(
      this.run(`UPDATE calls SET status = 'failed', updated_at = ?, ended_at = ? WHERE status IN (${marks})`, t, t, ...LIVE_STATUSES).changes,
    );
  }

  // Transcript
  addTranscript(userId: string, callId: string, speaker: Speaker, text: string): TranscriptEntry {
    const createdAt = now();
    const r = this.run(
      "INSERT INTO transcript_entries (user_id, call_id, speaker, text, created_at) VALUES (?, ?, ?, ?, ?)",
      userId,
      callId,
      speaker,
      text,
      createdAt,
    );
    return { id: Number(r.lastInsertRowid), callId, speaker, text, createdAt };
  }
  listTranscript(callId: string): TranscriptEntry[] {
    return this.all("SELECT * FROM transcript_entries WHERE call_id = ? ORDER BY id", callId).map((r) => ({
      id: Number(r.id),
      callId: String(r.call_id),
      speaker: r.speaker as Speaker,
      text: String(r.text),
      createdAt: String(r.created_at),
    }));
  }

  // Approvals
  private toApproval(r: Row): Approval {
    return {
      id: String(r.id),
      callId: String(r.call_id),
      question: String(r.question),
      options: JSON.parse(String(r.options_json)),
      status: r.status as ApprovalStatus,
      note: r.note == null ? null : String(r.note),
      createdAt: String(r.created_at),
      resolvedAt: r.resolved_at == null ? null : String(r.resolved_at),
    };
  }
  createApproval(userId: string, callId: string, question: string, options: string[]): Approval {
    const id = randomUUID().slice(0, 8);
    this.run(
      "INSERT INTO approvals (id, user_id, call_id, question, options_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      id,
      userId,
      callId,
      question,
      JSON.stringify(options),
      now(),
    );
    return this.getApproval(id)!;
  }
  getApproval(id: string): Approval | null {
    const r = this.get("SELECT * FROM approvals WHERE id = ?", id);
    return r ? this.toApproval(r) : null;
  }
  listApprovals(callId: string): Approval[] {
    return this.all("SELECT * FROM approvals WHERE call_id = ? ORDER BY created_at", callId).map((r) => this.toApproval(r));
  }
  /** Moves a pending approval to a final status; returns null if it was no longer pending. */
  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">, note: string | null): Approval | null {
    const r = this.run("UPDATE approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", status, note, now(), id);
    return Number(r.changes) ? this.getApproval(id) : null;
  }

  // Audit
  audit(userId: string, callId: string | null, kind: string, detail: Record<string, unknown>) {
    this.run(
      "INSERT INTO audit_events (user_id, call_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
      userId,
      callId,
      kind,
      JSON.stringify(detail),
      now(),
    );
  }
  listAudit(callId: string): AuditEvent[] {
    return this.all("SELECT * FROM audit_events WHERE call_id = ? ORDER BY id", callId).map((r) => ({
      id: Number(r.id),
      callId: r.call_id == null ? null : String(r.call_id),
      kind: String(r.kind),
      detail: JSON.parse(String(r.detail_json)),
      createdAt: String(r.created_at),
    }));
  }

  // Playbooks
  private toPlaybook(r: Row): Playbook {
    return {
      company: String(r.company),
      menuPaths: JSON.parse(String(r.menu_paths_json)),
      tactics: JSON.parse(String(r.tactics_json)),
      updatedAt: String(r.updated_at),
    };
  }
  getPlaybook(userId: string, company: string): Playbook | null {
    const r = this.get("SELECT * FROM playbooks WHERE user_id = ? AND company_key = ?", userId, companyKey(company));
    return r ? this.toPlaybook(r) : null;
  }
  listPlaybooks(userId: string): Playbook[] {
    return this.all("SELECT * FROM playbooks WHERE user_id = ? ORDER BY company", userId).map((r) => this.toPlaybook(r));
  }
  savePlaybook(userId: string, company: string, menuPaths: string[], tactics: string[]) {
    this.run(
      `INSERT INTO playbooks (user_id, company_key, company, menu_paths_json, tactics_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, company_key) DO UPDATE SET company = excluded.company, menu_paths_json = excluded.menu_paths_json,
       tactics_json = excluded.tactics_json, updated_at = excluded.updated_at`,
      userId,
      companyKey(company),
      company.trim(),
      JSON.stringify(menuPaths),
      JSON.stringify(tactics),
      now(),
    );
  }

  // Settings (raw key/value; secret values are stored encrypted by settings.ts)
  getSettingsRaw(userId: string): Record<string, string> {
    return Object.fromEntries(this.all("SELECT key, value FROM settings WHERE user_id = ?", userId).map((r) => [String(r.key), String(r.value)]));
  }
  setSetting(userId: string, key: string, value: string | null) {
    if (value === null) this.run("DELETE FROM settings WHERE user_id = ? AND key = ?", userId, key);
    else
      this.run(
        "INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
        userId,
        key,
        value,
      );
  }
}
