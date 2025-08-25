import mongoose from "mongoose";
import dotenv from "dotenv";
import CoA from "../models/coa.model.js";
import chartOfAccounts from "./chartOfAccounts.js";

dotenv.config();

const seed = async () => {
  try {
    // connect to DB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // clear existing CoA
    await CoA.deleteMany({});
    console.log("Cleared old CoA records");

    // insert new CoA
    await CoA.insertMany(chartOfAccounts);
    console.log("Seeded Chart of Accounts");

    process.exit(0);
  } catch (err) {
    console.error("Error seeding Chart of Accounts:", err);
    process.exit(1);
  }
};

seed();
