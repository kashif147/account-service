/**
 * Repair refund GL lines (2020) still keyed by applicationId + MaterializedBalance.
 *
 * Usage (from account-service root, MONGODB_URI set):
 *   node scripts/relink-refund-gl-for-application.js <tenantId> <applicationId> <memberId>
 *
 * tenantId must match Refund.tenantId so the Refund-document pass can find rows.
 */
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();
import mongoose from "mongoose";
import {
  relinkRefundGlFromApplicationToMember,
  relinkPostedRefundGlFromRefundDocuments,
} from "../src/controllers/journal.controller.js";

async function main() {
  const [, , tenantId, applicationId, memberId] = process.argv;
  if (!tenantId || !applicationId || !memberId) {
    console.error(
      "Usage: node scripts/relink-refund-gl-for-application.js <tenantId> <applicationId> <memberId>",
    );
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGODB_URI or MONGO_URI is required");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const byApp = await relinkRefundGlFromApplicationToMember({
    applicationId,
    memberId,
  });
  const byDoc = await relinkPostedRefundGlFromRefundDocuments({
    tenantId,
    applicationId,
    memberId,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        refundGlRelinkedByApplication: byApp.updated,
        refundGlRelinkedFromRefundDocs: byDoc.updated,
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
