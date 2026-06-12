import mongoose from "mongoose";

const TemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: null,
    },
    templateType: {
      type: String,
      default: "creditnotes",
      trim: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },
    tenantId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    columns: {
      type: [String],
      default: [],
    },
    columnLabels: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    visibleFilters: {
      type: [String],
      default: [],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    systemDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    meta: {
      deleted: {
        type: Boolean,
        default: false,
      },
      deletedAt: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true },
);

TemplateSchema.index({ userId: 1, "meta.deleted": 1 });
TemplateSchema.index({ userId: 1, isDefault: 1 });
TemplateSchema.index({ systemDefault: 1, "meta.deleted": 1 });
TemplateSchema.index({ tenantId: 1, userId: 1, "meta.deleted": 1 });
TemplateSchema.index({ tenantId: 1, systemDefault: 1, templateType: 1 });

export default mongoose.model("Template", TemplateSchema);
