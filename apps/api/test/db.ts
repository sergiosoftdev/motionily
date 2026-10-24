import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * The database a test file runs on: an in-memory mongod, or with TEST_DB=sqlite an in-memory SQLite
 * database through the SQLite driver (same suite, both storages).
 */
export async function testDatabase(name: string): Promise<{ stop(): Promise<void> }> {
  if (process.env.TEST_DB === "sqlite") {
    process.env.DATABASE_URL = "sqlite::memory:";
    return { stop: async () => undefined };
  }
  const mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri(name);
  return { stop: async () => void (await mongo.stop()) };
}
