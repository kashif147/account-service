import mongoose from "mongoose";

const productTypeSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      trim: true,
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

productTypeSchema.index({ tenantId: 1, code: 1 });
productTypeSchema.index({ tenantId: 1, isDeleted: 1 });

export default mongoose.model("ProductType", productTypeSchema);
