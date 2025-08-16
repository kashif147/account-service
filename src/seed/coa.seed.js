import mongoose from "mongoose";
import dotenv from "dotenv";
import CoA from "../models/coa.model.js";

dotenv.config();

const coaData = [
  { code: "1200", description: "Bank", type: "Asset" },
  { code: "1210", description: "Cheques in Hand", type: "Asset" },
  { code: "1220", description: "Stripe Clearing", type: "Asset" },
  { code: "1230", description: "Payroll Clearing", type: "Asset" },

  { code: "1400", description: "Accounts Receivable", type: "Asset" },
  { code: "2020", description: "Overpayments Held", type: "Liability" },

  { code: "4000", description: "Membership Fee Income", type: "Income" },
  { code: "4050", description: "Fee Increase Income", type: "Income" },
  { code: "4060", description: "Fee Decrease Adjustment", type: "Income" }, // negative direction
  { code: "4070", description: "Credit Notes / Discounts", type: "Income" }, // negative direction
];

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    await CoA.deleteMany({});
    console.log("Cleared old CoA records");

    await CoA.insertMany(coaData);
    console.log("Seeded Chart of Accounts");

    process.exit(0);
  } catch (err) {
    console.error("Error seeding CoA:", err);
    process.exit(1);
  }
};

seed();
