import mongoose from "mongoose";

const { Schema, Types } = mongoose;

/**
 * P5 member-level refund credit reservations: one document per (tenant, authoritative member
 * ledger key). While a refund that draws on the member's refundable credit is in flight its
 * amount is listed here, so concurrent refunds of DIFFERENT payments of the SAME member cannot
 * together exceed the member's available refundable credit.
 */
const ReservationSchema = new Schema(
  { opId: { type: Types.ObjectId, required: true }, amount: { type: Number, required: true }, at: { type: Date, default: Date.now } },
  { _id: false },
);

const MemberRefundReservationSchema = new Schema(
  {
    tenantId: { type: String, required: true },
    memberKey: { type: String, required: true },
    reservations: { type: [ReservationSchema], default: [] },
  },
  { timestamps: true },
);

MemberRefundReservationSchema.index({ tenantId: 1, memberKey: 1 }, { unique: true });

export const MemberRefundReservation =
  mongoose.models.MemberRefundReservation ||
  mongoose.model("MemberRefundReservation", MemberRefundReservationSchema);
export default MemberRefundReservation;
