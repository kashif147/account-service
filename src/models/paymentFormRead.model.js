import mongoose from "mongoose";
import { getProfileConnection } from "../config/profileDb.js";

const PaymentFormReadSchema = new mongoose.Schema(
  {
    tenantId: { type: String, index: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, index: true },
    membershipNumber: { type: String, index: true },
    formType: { type: String },
    status: { type: String },
    directDebitMandate: { type: mongoose.Schema.Types.Mixed },
    organisationSnapshot: { type: mongoose.Schema.Types.Mixed },
  },
  { collection: "memberpaymentforms", strict: false },
);

let PaymentFormRead = null;

export function getPaymentFormReadModel() {
  const conn = getProfileConnection();
  if (!conn) {
    throw new Error("Profile DB not connected; set PROFILE_MONGODB_URI");
  }
  if (!PaymentFormRead) {
    PaymentFormRead =
      conn.models.MemberPaymentForm ||
      conn.model("MemberPaymentForm", PaymentFormReadSchema);
  }
  return PaymentFormRead;
}
