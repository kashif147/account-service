import mongoose from "mongoose";
import GLTransaction from "../src/models/glTransaction.model.js";
import MaterializedBalance from "../src/models/materializedBalance.model.js";
import logger from "../src/config/logger.js";

/**
 * Migrates existing GLTransaction and MaterializedBalance amounts from euros to cents
 *
 * Strategy:
 * 1. Identify entries that are likely in euros (have decimal places, < 10000 for typical amounts)
 * 2. Multiply by 100 to convert to cents
 * 3. Update in batches
 *
 * WARNING: This is a destructive operation. Backup database first!
 */
async function migrateMoneyToCents() {
  const connectionString = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!connectionString) {
    throw new Error("MONGODB_URI or MONGO_URI environment variable required");
  }

  await mongoose.connect(connectionString);
  logger.info("Connected to MongoDB");

  // Step 1: Migrate GLTransaction entries
  logger.info("Starting GLTransaction migration...");
  const glTransactions = await GLTransaction.find({}).lean();
  let glUpdated = 0;
  let glSkipped = 0;
  let glErrors = 0;

  for (const txn of glTransactions) {
    try {
      let needsUpdate = false;
      const updatedEntries = txn.entries.map((entry) => {
        // Check if amount looks like euros (has decimal places and is reasonable)
        // Typical amounts: 326.00, 81.50, etc.
        // If amount is > 10000, it's likely already in cents
        if (entry.amount < 10000 && entry.amount % 1 !== 0) {
          // Has decimal places and is < 10000 - likely euros
          needsUpdate = true;
          return {
            ...entry,
            amount: Math.round(entry.amount * 100), // Convert to cents
          };
        }
        // If amount is already an integer and > 100, assume it's already in cents
        if (Number.isInteger(entry.amount) && entry.amount >= 100) {
          return entry; // Already in cents
        }
        // Small integer amounts (< 100) might be euros - convert
        // But be careful: 0, 1, 2 cents are valid, so only convert if > 0 and < 100
        if (entry.amount > 0 && entry.amount < 100 && Number.isInteger(entry.amount)) {
          // Could be euros (e.g., 0.50, 1.00) - convert
          needsUpdate = true;
          return {
            ...entry,
            amount: Math.round(entry.amount * 100),
          };
        }
        return entry;
      });

      if (needsUpdate) {
        await GLTransaction.updateOne(
          { _id: txn._id },
          { $set: { entries: updatedEntries } }
        );
        glUpdated++;
        if (glUpdated % 100 === 0) {
          logger.info(
            { updated: glUpdated, skipped: glSkipped, errors: glErrors },
            "GLTransaction migration progress"
          );
        }
      } else {
        glSkipped++;
      }
    } catch (error) {
      glErrors++;
      logger.error(
        {
          transactionId: txn._id,
          docNo: txn.docNo,
          error: error.message,
        },
        "Error migrating GLTransaction entry"
      );
    }
  }

  logger.info(
    { updated: glUpdated, skipped: glSkipped, errors: glErrors },
    "GLTransaction migration completed"
  );

  // Step 2: Migrate MaterializedBalance
  logger.info("Starting MaterializedBalance migration...");
  const balances = await MaterializedBalance.find({}).lean();
  let balUpdated = 0;
  let balSkipped = 0;
  let balErrors = 0;

  for (const bal of balances) {
    try {
      // Check if amount looks like euros
      if (bal.amount < 10000 && bal.amount % 1 !== 0) {
        // Has decimal places - convert to cents
        await MaterializedBalance.updateOne(
          { _id: bal._id },
          { $set: { amount: Math.round(bal.amount * 100) } }
        );
        balUpdated++;
        if (balUpdated % 100 === 0) {
          logger.info(
            { updated: balUpdated, skipped: balSkipped, errors: balErrors },
            "MaterializedBalance migration progress"
          );
        }
      } else if (bal.amount > 0 && bal.amount < 100 && Number.isInteger(bal.amount)) {
        // Small integer - might be euros
        await MaterializedBalance.updateOne(
          { _id: bal._id },
          { $set: { amount: Math.round(bal.amount * 100) } }
        );
        balUpdated++;
      } else {
        balSkipped++;
      }
    } catch (error) {
      balErrors++;
      logger.error(
        {
          balanceId: bal._id,
          memberId: bal.memberId,
          accountCode: bal.accountCode,
          error: error.message,
        },
        "Error migrating MaterializedBalance entry"
      );
    }
  }

  logger.info(
    { updated: balUpdated, skipped: balSkipped, errors: balErrors },
    "MaterializedBalance migration completed"
  );

  // Step 3: Verification - sample check
  logger.info("Running verification checks...");
  const sampleTxn = await GLTransaction.findOne({}).lean();
  if (sampleTxn && sampleTxn.entries.length > 0) {
    const sampleAmount = sampleTxn.entries[0].amount;
    logger.info(
      {
        sampleDocNo: sampleTxn.docNo,
        sampleAmount,
        isInteger: Number.isInteger(sampleAmount),
        looksLikeCents: sampleAmount >= 100 || sampleAmount === 0,
      },
      "Sample GLTransaction entry check"
    );
  }

  const sampleBal = await MaterializedBalance.findOne({}).lean();
  if (sampleBal) {
    logger.info(
      {
        sampleMemberId: sampleBal.memberId,
        sampleAccountCode: sampleBal.accountCode,
        sampleAmount: sampleBal.amount,
        isInteger: Number.isInteger(sampleBal.amount),
        looksLikeCents: sampleBal.amount >= 100 || sampleBal.amount === 0,
      },
      "Sample MaterializedBalance entry check"
    );
  }

  await mongoose.disconnect();
  logger.info("Migration completed");
}

// Run migration
migrateMoneyToCents()
  .then(() => {
    logger.info("Migration script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    logger.error(
      { error: error.message, stack: error.stack },
      "Migration failed"
    );
    process.exit(1);
  });
