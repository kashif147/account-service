// Template model - replace with your service-specific models
import mongoose from "mongoose";

const templateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "pending"],
      default: "active",
    },
    metadata: {
      type: Map,
      of: String,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
templateSchema.index({ name: 1 });
templateSchema.index({ status: 1 });
templateSchema.index({ createdAt: -1 });

export default mongoose.model("Template", templateSchema);
