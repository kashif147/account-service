import mongoose from "mongoose";

// Mirrors user-service pricing identities: same Mongo ObjectId hex strings as strings here
// because Product._id in this service is String; queries use productId === product._id.
const pricingSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    productId: {
      type: String,
      required: true,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
    },
    price: {
      type: Number,
      default: null,
    },
    memberPrice: {
      type: Number,
      default: null,
    },
    nonMemberPrice: {
      type: Number,
      default: null,
    },
    effectiveFrom: {
      type: Date,
      default: null,
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    tenantId: {
      type: String,
      required: true,
    },
    createdBy: {
      type: String,
      default: null,
    },
    updatedBy: {
      type: String,
      default: null,
    },
    createdAt: {
      type: Date,
      default: null,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: false }
);

pricingSchema.index({ tenantId: 1, productId: 1 });
pricingSchema.index({ tenantId: 1, isDeleted: 1 });

export default mongoose.model("Pricing", pricingSchema);
