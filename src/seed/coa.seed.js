// src/seed/coa.seed.js
import mongoose from "mongoose";
import dotenvFlow from "dotenv-flow"; // <-- change from 'dotenv'
import CoA from "../models/coa.model.js";
import chartOfAccounts from "./chartOfAccounts.js";

// Load env based on NODE_ENV automatically
dotenvFlow.config();

const seed = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    console.log("🔄 Connecting to MongoDB:", mongoUri);

    await mongoose.connect(mongoUri, {
      dbName: "account-service", // Adjust if your DB name is different
    });

    const admin = mongoose.connection.db.admin();
    const info = await admin.serverStatus();
    console.log("✅ MongoDB connection established:", {
      version: info.version,
      host: mongoose.connection.host,
      name: mongoose.connection.name,
    });

    await CoA.deleteMany({});
    console.log("🗑️ Cleared old CoA records");

    await CoA.insertMany(chartOfAccounts);
    console.log(`🌱 Seeded ${chartOfAccounts.length} Chart of Accounts records`);

    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding Chart of Accounts:", err.message);
    process.exit(1);
  }
};

seed();

