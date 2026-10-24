import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import mongoose from "mongoose";
import { Aggregator, Query } from "mingo";
import { update as applyUpdate } from "mingo/updater";

/**
 * A Mongoose driver that keeps every collection in one SQLite file, so the desktop app (and anyone who
 * does not want to run MongoDB) needs nothing installed. Mongoose itself is unchanged: documents,
 * schemas, defaults, validation and queries all run as usual; only the storage under the driver differs.
 * Filters, updates and pipelines are evaluated in JS with mingo, over documents kept in memory per
 * collection and written through to SQLite on every change. Meant for one local user, not for scale.
 *
 * Select it with DATABASE_URL (or MONGO_URI) = `sqlite:/abs/path/motionily.db` or `sqlite::memory:`.
 */

const SQLITE_SCHEME = "sqlite:";
const MEMORY = ":memory:";
const { ObjectId } = mongoose.Types;
const { EJSON } = mongoose.mongo.BSON;
type ObjectIdT = InstanceType<typeof ObjectId>;
type Doc = Record<string, any> & { _id?: unknown };
type Filter = Record<string, any>;
type Sort = Record<string, 1 | -1> | undefined;
type IndexSpec = { name: string; key: Record<string, number>; unique: boolean; sparse: boolean };

export function isSqliteUri(uri: string | undefined): uri is string {
  return !!uri && uri.startsWith(SQLITE_SCHEME);
}

/** Database file path from `sqlite:/path`, `sqlite:///path` or `sqlite::memory:`. */
export function sqlitePath(uri: string): string {
  const rest = uri.slice(SQLITE_SCHEME.length).replace(/^\/\/(?=\/)/, "");
  return rest === MEMORY || rest === "" ? MEMORY : resolve(rest);
}

/** Deep copy that keeps ObjectId, Date and binary values (structuredClone would flatten ObjectIds). */
function clone<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof ObjectId) return new ObjectId((v as ObjectIdT).toHexString()) as T;
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (Buffer.isBuffer(v)) return Buffer.from(v) as T;
  // Mongoose documents, subdocuments and arrays: what the real driver would serialize.
  if (typeof (v as { toBSON?: unknown }).toBSON === "function") return clone((v as unknown as { toBSON(): T }).toBSON());
  if (ArrayBuffer.isView(v)) return (v as unknown as Uint8Array).slice() as T;
  if (Array.isArray(v)) return Array.prototype.map.call(v, clone) as T;
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
    // BSON values (Decimal128, Long…) and anything else with its own class: round-trip through EJSON.
    return EJSON.deserialize(EJSON.serialize(v, { relaxed: false }), { relaxed: false }) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = clone(x);
  return out as T;
}

const idKey = (id: unknown): string => (id instanceof ObjectId ? `o:${(id as ObjectIdT).toHexString()}` : `j:${EJSON.stringify(id as any, { relaxed: false })}`);

function getPath(doc: Doc, path: string): unknown {
  let cur: any = doc;
  for (const p of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Error shaped like the MongoDB server's duplicate key error (code 11000), which services catch. */
class DuplicateKeyError extends Error {
  readonly code = 11000;
  readonly keyValue: Record<string, unknown>;
  constructor(collection: string, index: IndexSpec, doc: Doc) {
    const keyValue = Object.fromEntries(Object.keys(index.key).map((k) => [k, getPath(doc, k)]));
    super(`E11000 duplicate key error collection: ${collection} index: ${index.name} dup key: ${EJSON.stringify(keyValue as any)}`);
    this.name = "MongoServerError";
    this.keyValue = keyValue;
  }
}

/** The subset of a driver cursor Mongoose uses: chainable modifiers, toArray and async iteration. */
class Cursor {
  private sortSpec: Sort;
  private skipN = 0;
  private limitN = 0;
  constructor(
    private readonly load: (sort: Sort, skip: number, limit: number) => Doc[],
    o: { sort?: Sort; skip?: number; limit?: number } = {},
  ) {
    this.sortSpec = o.sort;
    this.skipN = o.skip ?? 0;
    this.limitN = o.limit ?? 0;
  }
  sort(s: Sort) {
    this.sortSpec = s;
    return this;
  }
  skip(n: number) {
    this.skipN = n;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  async toArray(): Promise<Doc[]> {
    return this.load(this.sortSpec, this.skipN, this.limitN);
  }
  async *[Symbol.asyncIterator]() {
    for (const d of await this.toArray()) yield d;
  }
  async close() {}
  async explain() {
    return { queryPlanner: { winningPlan: { stage: "SQLITE_SCAN" } } };
  }
}

/** Mongoose's sort option arrives as an object, an array of pairs or a Map. */
function normalizeSort(sort: unknown): Sort {
  if (!sort) return undefined;
  if (sort instanceof Map) return Object.fromEntries(sort) as Sort;
  if (Array.isArray(sort)) return Object.fromEntries(sort.map((s) => (Array.isArray(s) ? s : [s, 1]))) as Sort;
  return sort as Sort;
}

function hasOperators(u: Doc): boolean {
  return Object.keys(u).some((k) => k.startsWith("$"));
}

/** Equality fields of a filter, which seed an upserted document (like MongoDB does). */
function seedFromFilter(filter: Filter): Doc {
  const seed: Doc = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith("$")) continue;
    const value = v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date) && !Array.isArray(v) ? ("$eq" in v ? v.$eq : undefined) : v;
    if (value === undefined) continue;
    applyUpdate(seed, { $set: { [k]: clone(value) } });
  }
  return seed;
}

/**
 * MongoDB's `$in` also matches an array field equal to an array in the list (`fits: { $in: ["x", []] }`
 * matches `fits: []`); mingo only compares elements, so such lists become an `$or` of whole-array `$eq`s.
 */
function mongoFilter(filter: Filter): Filter {
  const out: Filter = {};
  const ors: Filter[][] = [];
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or" || k === "$and" || k === "$nor") {
      out[k] = (v as Filter[]).map(mongoFilter);
      continue;
    }
    const inList = v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.$in) ? (v.$in as unknown[]) : null;
    if (inList?.some(Array.isArray) && Object.keys(v).length === 1) {
      const scalars = inList.filter((x) => !Array.isArray(x));
      ors.push([...(scalars.length ? [{ [k]: { $in: scalars } }] : []), ...inList.filter(Array.isArray).map((arr) => ({ [k]: { $eq: arr } }))]);
      continue;
    }
    out[k] = v;
  }
  if (!ors.length) return out;
  return { $and: [out, ...ors.map(($or) => ({ $or }))] };
}

class SqliteCollection {
  readonly collectionName: string;
  readonly namespace: string;
  private docs: Map<string, Doc> | null = null;
  private readonly indexSpecs = new Map<string, IndexSpec>();

  constructor(
    private readonly db: SqliteDb,
    name: string,
  ) {
    this.collectionName = name;
    this.namespace = `${db.databaseName}.${name}`;
  }

  /** Every document of the collection, read from SQLite once and then kept in memory. */
  private all(): Map<string, Doc> {
    if (!this.docs) {
      this.docs = new Map();
      for (const row of this.db.rows(this.collectionName)) this.docs.set(row.id, EJSON.parse(row.body, { relaxed: false }) as Doc);
    }
    return this.docs;
  }

  private persist(doc: Doc) {
    this.db.write(this.collectionName, idKey(doc._id), EJSON.stringify(doc as any, { relaxed: false }));
  }

  private matches(filter: Filter = {}): Doc[] {
    const q = new Query(mongoFilter(clone(filter ?? {})));
    return [...this.all().values()].filter((d) => q.test(d));
  }

  private select(filter: Filter, o: { sort?: unknown; skip?: number; limit?: number; projection?: Doc }): Doc[] {
    const q = new Query(mongoFilter(clone(filter ?? {})));
    let cursor = q.find([...this.all().values()], o.projection && Object.keys(o.projection).length ? o.projection : undefined);
    const sort = normalizeSort(o.sort);
    if (sort) cursor = cursor.sort(sort);
    if (o.skip) cursor = cursor.skip(o.skip);
    if (o.limit) cursor = cursor.limit(o.limit);
    return cursor.all().map((d) => clone(d as Doc));
  }

  private checkUnique(doc: Doc, ignoreKey?: string) {
    for (const index of this.indexSpecs.values()) {
      if (!index.unique) continue;
      const fields = Object.keys(index.key);
      const values = fields.map((f) => getPath(doc, f));
      if (index.sparse && values.every((v) => v === undefined)) continue;
      const key = EJSON.stringify(values.map((v) => (v === undefined ? null : v)) as any, { relaxed: false });
      for (const [k, other] of this.all()) {
        if (k === ignoreKey) continue;
        const ov = fields.map((f) => getPath(other, f));
        if (index.sparse && ov.every((v) => v === undefined)) continue;
        if (EJSON.stringify(ov.map((v) => (v === undefined ? null : v)) as any, { relaxed: false }) === key) throw new DuplicateKeyError(this.namespace, index, doc);
      }
    }
  }

  private insert(doc: Doc): Doc {
    const d = clone(doc);
    if (d._id === undefined) d._id = new ObjectId();
    const key = idKey(d._id);
    if (this.all().has(key)) throw new DuplicateKeyError(this.namespace, { name: "_id_", key: { _id: 1 }, unique: true, sparse: false }, d);
    this.checkUnique(d);
    this.all().set(key, d);
    this.persist(d);
    return d;
  }

  /** Applies an operator update (or a replacement) to one stored document; returns whether it changed. */
  private modify(key: string, current: Doc, update: Doc, o: { upserting?: boolean; arrayFilters?: Doc[]; replace?: boolean }): Doc {
    const u = clone(update);
    let next: Doc;
    if (o.replace || !hasOperators(u)) {
      next = { ...clone(u), _id: current._id };
    } else {
      next = clone(current);
      const { $setOnInsert, ...ops } = u;
      if (o.upserting && $setOnInsert) applyUpdate(next, { $set: $setOnInsert }, o.arrayFilters, undefined, { cloneMode: "deep" });
      if (Object.keys(ops).length) applyUpdate(next, ops as never, o.arrayFilters, undefined, { cloneMode: "deep" });
    }
    this.checkUnique(next, key);
    this.all().set(key, next);
    this.persist(next);
    return next;
  }

  private first(filter: Filter, sort?: unknown): Doc | undefined {
    const s = normalizeSort(sort);
    if (!s) return this.matches(filter)[0];
    return new Query(mongoFilter(clone(filter ?? {}))).find([...this.all().values()]).sort(s).limit(1).all()[0] as Doc | undefined;
  }

  private upsertNew(filter: Filter, update: Doc, o: { arrayFilters?: Doc[]; replace?: boolean }): Doc {
    const u = clone(update);
    const base = o.replace || !hasOperators(u) ? { ...seedFromFilter(filter), ...clone(u) } : seedFromFilter(filter);
    if (base._id === undefined) base._id = new ObjectId();
    const key = idKey(base._id);
    const doc = o.replace || !hasOperators(u) ? base : (() => {
      const { $setOnInsert, ...ops } = u;
      if ($setOnInsert) applyUpdate(base, { $set: $setOnInsert }, o.arrayFilters, undefined, { cloneMode: "deep" });
      if (Object.keys(ops).length) applyUpdate(base, ops as never, o.arrayFilters, undefined, { cloneMode: "deep" });
      return base;
    })();
    this.checkUnique(doc);
    this.all().set(key, doc);
    this.persist(doc);
    return doc;
  }

  // ---- The driver Collection API Mongoose calls ----

  async insertOne(doc: Doc) {
    const d = this.insert(doc);
    doc._id ??= d._id;
    return { acknowledged: true, insertedId: d._id };
  }

  async insertMany(docs: Doc[], o: { ordered?: boolean } = {}) {
    const insertedIds: Record<number, unknown> = {};
    docs.forEach((doc, i) => {
      try {
        insertedIds[i] = this.insert(doc)._id;
        doc._id ??= insertedIds[i];
      } catch (e) {
        if (o.ordered !== false) throw e;
      }
    });
    return { acknowledged: true, insertedCount: Object.keys(insertedIds).length, insertedIds };
  }

  find(filter: Filter = {}, o: { sort?: unknown; skip?: number; limit?: number; projection?: Doc } = {}) {
    return new Cursor((sort, skip, limit) => this.select(filter, { ...o, sort: sort ?? o.sort, skip: skip || o.skip, limit: limit || o.limit }), {});
  }

  async findOne(filter: Filter = {}, o: { sort?: unknown; projection?: Doc; skip?: number } = {}) {
    return this.select(filter, { ...o, limit: 1 })[0] ?? null;
  }

  async countDocuments(filter: Filter = {}, o: { skip?: number; limit?: number } = {}) {
    let n = this.matches(filter).length - (o.skip ?? 0);
    if (o.limit) n = Math.min(n, o.limit);
    return Math.max(0, n);
  }

  async estimatedDocumentCount() {
    return this.all().size;
  }

  async distinct(field: string, filter: Filter = {}) {
    const seen = new Map<string, unknown>();
    for (const d of this.matches(filter)) {
      const v = getPath(d, field);
      for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) seen.set(EJSON.stringify(x as any, { relaxed: false }), clone(x));
    }
    return [...seen.values()];
  }

  async updateOne(filter: Filter, u: Doc, o: { upsert?: boolean; arrayFilters?: Doc[]; sort?: unknown } = {}) {
    const doc = this.first(filter, o.sort);
    if (doc) {
      this.modify(idKey(doc._id), doc, u, o);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
    }
    if (!o.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    const created = this.upsertNew(filter, u, o);
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
  }

  async updateMany(filter: Filter, u: Doc, o: { upsert?: boolean; arrayFilters?: Doc[] } = {}) {
    const docs = this.matches(filter);
    for (const d of docs) this.modify(idKey(d._id), d, u, o);
    if (!docs.length && o.upsert) {
      const created = this.upsertNew(filter, u, o);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
    }
    return { acknowledged: true, matchedCount: docs.length, modifiedCount: docs.length, upsertedCount: 0, upsertedId: null };
  }

  async replaceOne(filter: Filter, replacement: Doc, o: { upsert?: boolean } = {}) {
    const doc = this.first(filter);
    if (doc) {
      this.modify(idKey(doc._id), doc, replacement, { replace: true });
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
    }
    if (!o.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    const created = this.upsertNew(filter, replacement, { replace: true });
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
  }

  /** findOneAnd*: the document (before or after), or `{ value, ok, lastErrorObject }` with includeResultMetadata. */
  private oneResult(value: Doc | null, o: { includeResultMetadata?: boolean; projection?: Doc }, last: Record<string, unknown>) {
    const out = value && o.projection && Object.keys(o.projection).length ? (new Query({}).find([value], o.projection).all()[0] as Doc) : value;
    const v = out ? clone(out) : null;
    return o.includeResultMetadata ? { value: v, ok: 1, lastErrorObject: last } : v;
  }

  async findOneAndUpdate(filter: Filter, u: Doc, o: { upsert?: boolean; returnDocument?: "before" | "after"; returnOriginal?: boolean; sort?: unknown; arrayFilters?: Doc[]; projection?: Doc; includeResultMetadata?: boolean } = {}) {
    const after = o.returnDocument ? o.returnDocument === "after" : o.returnOriginal === false;
    const doc = this.first(filter, o.sort);
    if (doc) {
      const before = clone(doc);
      const next = this.modify(idKey(doc._id), doc, u, o);
      return this.oneResult(after ? next : before, o, { n: 1, updatedExisting: true });
    }
    if (!o.upsert) return this.oneResult(null, o, { n: 0, updatedExisting: false });
    const created = this.upsertNew(filter, u, o);
    return this.oneResult(after ? created : null, o, { n: 1, updatedExisting: false, upserted: created._id });
  }

  async findOneAndReplace(filter: Filter, replacement: Doc, o: { upsert?: boolean; returnDocument?: "before" | "after"; sort?: unknown; projection?: Doc; includeResultMetadata?: boolean } = {}) {
    const after = o.returnDocument === "after";
    const doc = this.first(filter, o.sort);
    if (doc) {
      const before = clone(doc);
      const next = this.modify(idKey(doc._id), doc, replacement, { replace: true });
      return this.oneResult(after ? next : before, o, { n: 1, updatedExisting: true });
    }
    if (!o.upsert) return this.oneResult(null, o, { n: 0, updatedExisting: false });
    const created = this.upsertNew(filter, replacement, { replace: true });
    return this.oneResult(after ? created : null, o, { n: 1, updatedExisting: false, upserted: created._id });
  }

  async findOneAndDelete(filter: Filter, o: { sort?: unknown; projection?: Doc; includeResultMetadata?: boolean } = {}) {
    const doc = this.first(filter, o.sort);
    if (doc) this.remove(doc);
    return this.oneResult(doc ?? null, o, { n: doc ? 1 : 0 });
  }

  private remove(doc: Doc) {
    const key = idKey(doc._id);
    this.all().delete(key);
    this.db.delete(this.collectionName, key);
  }

  async deleteOne(filter: Filter = {}) {
    const doc = this.first(filter);
    if (doc) this.remove(doc);
    return { acknowledged: true, deletedCount: doc ? 1 : 0 };
  }

  async deleteMany(filter: Filter = {}) {
    const docs = this.matches(filter);
    for (const d of docs) this.remove(d);
    return { acknowledged: true, deletedCount: docs.length };
  }

  aggregate(pipeline: Doc[] = []) {
    return new Cursor(() => (new Aggregator(pipeline).run([...this.all().values()].map(clone)) as Doc[]).map(clone));
  }

  async bulkWrite(ops: Doc[], o: { ordered?: boolean } = {}) {
    const r = { insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, insertedIds: {} as Record<number, unknown>, upsertedIds: {} as Record<number, unknown> };
    for (const [i, op] of ops.entries()) {
      try {
        if (op.insertOne) {
          r.insertedIds[i] = (await this.insertOne(op.insertOne.document)).insertedId;
          r.insertedCount++;
        } else if (op.updateOne || op.updateMany || op.replaceOne) {
          const spec = op.updateOne ?? op.updateMany ?? op.replaceOne;
          const res = op.updateOne
            ? await this.updateOne(spec.filter, spec.update, spec)
            : op.updateMany
              ? await this.updateMany(spec.filter, spec.update, spec)
              : await this.replaceOne(spec.filter, spec.replacement, spec);
          r.matchedCount += res.matchedCount;
          r.modifiedCount += res.modifiedCount;
          r.upsertedCount += res.upsertedCount;
          if (res.upsertedId) r.upsertedIds[i] = res.upsertedId;
        } else if (op.deleteOne) {
          r.deletedCount += (await this.deleteOne(op.deleteOne.filter)).deletedCount;
        } else if (op.deleteMany) {
          r.deletedCount += (await this.deleteMany(op.deleteMany.filter)).deletedCount;
        }
      } catch (e) {
        if (o.ordered !== false) throw e;
      }
    }
    return { acknowledged: true, ...r, isOk: () => true, hasWriteErrors: () => false, getWriteErrors: () => [] };
  }

  // ---- Indexes: only unique ones change behavior; the rest are recorded so syncIndexes is a no-op ----

  async createIndex(key: Record<string, number>, o: { name?: string; unique?: boolean; sparse?: boolean } = {}) {
    const name = o.name ?? Object.entries(key).map(([k, v]) => `${k}_${v}`).join("_");
    const spec = { name, key, unique: !!o.unique, sparse: !!o.sparse };
    if (spec.unique) for (const [k, d] of this.all()) this.checkUniqueWith(spec, d, k);
    this.indexSpecs.set(name, spec);
    return name;
  }

  private checkUniqueWith(spec: IndexSpec, doc: Doc, key: string) {
    const saved = new Map(this.indexSpecs);
    this.indexSpecs.clear();
    this.indexSpecs.set(spec.name, spec);
    try {
      this.checkUnique(doc, key);
    } finally {
      this.indexSpecs.clear();
      for (const [k, v] of saved) this.indexSpecs.set(k, v);
    }
  }

  async createIndexes(specs: { key: Record<string, number>; name?: string; unique?: boolean; sparse?: boolean }[]) {
    return Promise.all(specs.map((s) => this.createIndex(s.key, s)));
  }

  listIndexes() {
    return new Cursor(() => [{ v: 2, key: { _id: 1 }, name: "_id_" }, ...[...this.indexSpecs.values()].map((i) => ({ v: 2, key: i.key, name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.sparse ? { sparse: true } : {}) }))]);
  }

  async indexes() {
    return this.listIndexes().toArray();
  }

  async indexExists(names: string | string[]) {
    return (Array.isArray(names) ? names : [names]).every((n) => this.indexSpecs.has(n));
  }

  async dropIndex(name: string) {
    this.indexSpecs.delete(name);
    return { ok: 1 };
  }

  async dropIndexes() {
    this.indexSpecs.clear();
    return true;
  }

  async drop() {
    this.db.clear(this.collectionName);
    this.docs = new Map();
    return true;
  }

  watch(): never {
    throw new Error("change streams are not available with the SQLite driver");
  }
}

/** One SQLite file holding every collection: a `docs` table keyed by collection and _id. */
export class SqliteDb {
  readonly databaseName: string;
  private readonly sql: DatabaseSync;
  private readonly collections = new Map<string, SqliteCollection>();
  private readonly stmts: Record<"rows" | "write" | "delete" | "drop" | "names", ReturnType<DatabaseSync["prepare"]>>;

  constructor(readonly path: string) {
    if (path !== MEMORY) mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.sql.exec("CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection, id)) WITHOUT ROWID");
    this.databaseName = path === MEMORY ? "memory" : (path.split("/").pop() ?? "motionily").replace(/\.\w+$/, "");
    this.stmts = {
      rows: this.sql.prepare("SELECT id, body FROM docs WHERE collection = ?"),
      write: this.sql.prepare("INSERT INTO docs (collection, id, body) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body"),
      delete: this.sql.prepare("DELETE FROM docs WHERE collection = ? AND id = ?"),
      drop: this.sql.prepare("DELETE FROM docs WHERE collection = ?"),
      names: this.sql.prepare("SELECT DISTINCT collection FROM docs"),
    };
  }

  rows(collection: string) {
    return this.stmts.rows.all(collection) as { id: string; body: string }[];
  }
  write(collection: string, id: string, body: string) {
    this.stmts.write.run(collection, id, body);
  }
  delete(collection: string, id: string) {
    this.stmts.delete.run(collection, id);
  }
  clear(collection: string) {
    this.stmts.drop.run(collection);
  }

  collection(name: string): SqliteCollection {
    let c = this.collections.get(name);
    if (!c) this.collections.set(name, (c = new SqliteCollection(this, name)));
    return c;
  }

  async createCollection(name: string) {
    return this.collection(name);
  }

  listCollections(filter: { name?: string } = {}) {
    const names = new Set([...(this.stmts.names.all() as { collection: string }[]).map((r) => r.collection), ...this.collections.keys()]);
    return new Cursor(() => [...names].filter((n) => !filter.name || n === filter.name).map((name) => ({ name, type: "collection" })));
  }

  async dropCollection(name: string) {
    await this.collection(name).drop();
    return true;
  }

  async dropDatabase() {
    this.sql.exec("DELETE FROM docs");
    this.collections.clear();
    return true;
  }

  async command(cmd: Record<string, unknown>) {
    if ("ping" in cmd) return { ok: 1 };
    throw new Error(`the SQLite driver does not run commands (${Object.keys(cmd)[0]})`);
  }

  close() {
    this.sql.close();
  }
}

/** The pieces of Mongoose's own MongoDB driver we reuse unchanged. */
const NATIVE = "mongoose/lib/drivers/node-mongodb-native";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require(NATIVE) as { Collection: unknown; Connection: new (...a: unknown[]) => any; BulkWriteResult: unknown };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const STATES = require("mongoose/lib/connectionState") as Record<string, number>;

/** A Mongoose connection that opens a SqliteDb instead of a MongoClient. */
class SqliteConnection extends native.Connection {
  async createClient(this: any, uri: string, options: Record<string, any> = {}) {
    this._connectionString = uri;
    this._connectionOptions = options;
    if (options.autoIndex != null) this.config.autoIndex = options.autoIndex !== false;
    if (options.bufferCommands != null) this.config.bufferCommands = options.bufferCommands;
    const db = new SqliteDb(sqlitePath(uri));
    this.db = db;
    this.client = { close: async () => db.close(), db: () => db, on: () => undefined, s: { options: {} } };
    this.name = db.databaseName;
    this.readyState = STATES.connected;
    this.onOpen();
    for (const c of Object.values(this.collections) as { onOpen(): void }[]) c.onOpen();
    return this;
  }

  async doClose(this: any) {
    this.db?.close();
    return this;
  }

  async listDatabases(this: any) {
    return { databases: [{ name: this.name }] };
  }
}

let installed = false;

/** Switches Mongoose to the SQLite driver. Call before any connection opens. */
export function useSqliteDriver() {
  if (installed) return;
  installed = true;
  mongoose.setDriver({ Collection: native.Collection, Connection: SqliteConnection, BulkWriteResult: native.BulkWriteResult });
}
