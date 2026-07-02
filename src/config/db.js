import mongoose from "mongoose";
import config from "./index.js";

export async function connectDB() {
  try {
    mongoose.set("strictQuery", true);
    await mongoose.connect(config.mongoUri, {
      maxPoolSize: 10, // plenty for a single instance; default 100 wastes sockets
      serverSelectionTimeoutMS: 10000,
    });
    console.log("✓ MongoDB connected");
  } catch (err) {
    console.error("✗ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

export default connectDB;
