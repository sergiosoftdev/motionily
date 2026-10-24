import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import mongoose from "mongoose";
import { SqliteDb } from "../src/common/sqlite-driver";

test("SQLite driver: documents read back from disk match queries like the ones just written", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "motionily-sqlite-")), "test.db");
  const id = new mongoose.Types.ObjectId();
  const at = new Date("2026-10-24T12:00:00Z");
  const first = new SqliteDb(file);
  await first.collection("projects").insertOne({ _id: id, sceneRevision: 1, ratio: 0.5, at, tags: ["a"] });
  first.close();

  // A new process: everything comes from the file.
  const db = new SqliteDb(file);
  const projects = db.collection("projects");
  const doc = await projects.findOne({ _id: id, sceneRevision: 1 });
  assert.ok(doc, "an integer field matches after a reload");
  assert.equal(typeof doc.sceneRevision, "number");
  assert.equal(doc.ratio, 0.5);
  assert.ok(doc.at instanceof Date && doc.at.getTime() === at.getTime());
  assert.ok(doc._id instanceof mongoose.Types.ObjectId);
  assert.ok(await projects.findOne({ at: { $lt: new Date("2027-01-01") } }));

  const updated = await projects.findOneAndUpdate({ _id: id, sceneRevision: 1 }, { $inc: { sceneRevision: 1 } }, { returnDocument: "after" });
  assert.equal((updated as { sceneRevision: number }).sceneRevision, 2);
  db.close();
});
