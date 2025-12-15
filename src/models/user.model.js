import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  // Tenant isolation - mandatory field
  tenantId: {
    type: String,
    required: true,
    index: true,
  },

  userId: {
    type: String,
    required: true,
    index: true,
  },

  userEmail: { type: String, default: null },
  userFullName: { type: String, default: null },

  // Audit fields
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Compound indexes for tenant isolation
UserSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
UserSchema.index({ tenantId: 1, userEmail: 1 });

// Pre-save middleware to update audit fields
UserSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model("User", UserSchema);






