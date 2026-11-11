import mongoose from "mongoose";
import config from "./index.js";

export async function connectDB() {
  try {
    mongoose.set("strictQuery", true);
    // The database named in MONGODB_URI wins (staging uses .../chuma_staging);
    // "chuma" is only the fallback for a URI that names none. Forcing "chuma"
    // here sent the staging service into the production database.
    const uriDb = (() => {
      try {
        const path = new URL(config.mongoUri.replace(/^mongodb(\+srv)?:\/\//, "http://")).pathname;
        return decodeURIComponent(path.replace(/^\//, "")) || null;
      } catch {
        return null;
      }
    })();
    await mongoose.connect(config.mongoUri, {
      dbName: uriDb || "chuma",
      maxPoolSize: 10, // plenty for a single instance; default 100 wastes sockets
      serverSelectionTimeoutMS: 10000,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }
}

export default connectDB;
