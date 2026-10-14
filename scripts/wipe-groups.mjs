// Wipes every collection except users, for a fresh start.
// Dry run by default; pass --confirm to actually delete.
import "dotenv/config";
import mongoose from "mongoose";

const KEEP = ["users"];

const confirm = process.argv.includes("--confirm");
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const uri = new URL(process.env.MONGODB_URI.replace(/^mongodb\+srv/, "http"));
console.log(`Host: ${uri.hostname}  DB: ${db.databaseName}`);
console.log(`users (kept): ${await db.collection("users").countDocuments()}`);

const collections = await db.listCollections({}, { nameOnly: true }).toArray();
for (const { name } of collections) {
  if (KEEP.includes(name) || name.startsWith("system.")) continue;
  const col = db.collection(name);
  if (confirm) {
    const { deletedCount } = await col.deleteMany({});
    console.log(`${name}: deleted ${deletedCount}`);
  } else {
    console.log(`${name}: ${await col.countDocuments()} (would delete)`);
  }
}
if (!confirm) console.log("\nDry run. Re-run with --confirm to delete.");
await mongoose.disconnect();
