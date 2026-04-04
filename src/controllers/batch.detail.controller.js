import { v4 as uuidv4 } from "uuid";
import BatchDetail from "../models/batch.detail.model.js";
import User from "../models/user.model.js";
import { getProfileReadModel } from "../models/profileRead.model.js";
import * as azureBlob from "../services/azure.blob.service.js";
import * as batchPaymentProcess from "../services/batch.payment.process.service.js";
import {
  publisher,
  BATCH_PROCESS_EVENTS,
} from "../rabbitMQ/index.js";
import logger from "../config/logger.js";

function escapeRegexMembership(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROFILE_LOOKUP_SELECT =
  "membershipNumber personalInfo contactInfo professionalDetails preferences";

/**
 * Resolves a profile for batch flows (same DB and tenant rules as batch payment processing).
 * Returns clearer failure reasons for staging/debug (wrong PROFILE DB, tenant mismatch, legacy profiles without tenantId).
 */
async function findProfileByMembershipNumber(membershipNumberTrimmed, tenantId) {
  const Profile = getProfileReadModel();

  const withTenant = (q) =>
    tenantId ? { ...q, tenantId } : q;

  let profile = await Profile.findOne(
    withTenant({ membershipNumber: membershipNumberTrimmed })
  )
    .select(PROFILE_LOOKUP_SELECT)
    .lean();

  if (!profile && tenantId) {
    profile = await Profile.findOne(
      withTenant({
        membershipNumber: {
          $regex: new RegExp(
            `^${escapeRegexMembership(membershipNumberTrimmed)}$`,
            "i"
          ),
        },
      })
    )
      .select(PROFILE_LOOKUP_SELECT)
      .lean();
  }

  if (profile) return { profile, lookupError: null };

  if (tenantId) {
    const byNumber = await Profile.findOne({
      membershipNumber: membershipNumberTrimmed,
    })
      .select("tenantId membershipNumber")
      .lean();
    const byNumberCi =
      byNumber ||
      (await Profile.findOne({
        membershipNumber: {
          $regex: new RegExp(
            `^${escapeRegexMembership(membershipNumberTrimmed)}$`,
            "i"
          ),
        },
      })
        .select("tenantId membershipNumber")
        .lean());

    if (byNumberCi) {
      const pt = byNumberCi.tenantId;
      if (pt != null && pt !== "" && pt !== tenantId) {
        return {
          profile: null,
          lookupError:
            "A profile exists for this membership number but under a different tenant than your session. Align profile.tenantId with the gateway x-tenant-id (or use the correct CRM tenant).",
        };
      }
      if (pt == null || pt === "") {
        return {
          profile: null,
          lookupError:
            "A profile exists for this membership number but it has no tenantId set; batch resolution requires tenantId on the profile to match your session.",
        };
      }
      if (pt === tenantId) {
        const full = await Profile.findById(byNumberCi._id)
          .select(PROFILE_LOOKUP_SELECT)
          .lean();
        if (full) return { profile: full, lookupError: null };
      }
    }
  }

  return {
    profile: null,
    lookupError:
      "No profile found with this membership number. Confirm the member exists in profile-service, account-service PROFILE_MONGODB_URI points at that database, and the number matches exactly.",
  };
}

function batchPaymentsProfilePopulate() {
  return {
    path: "batchPayments.profileId",
    model: getProfileReadModel(),
    select:
      "membershipNumber personalInfo contactInfo professionalDetails preferences",
  };
}

async function resolveCreatedByName(createdBy, tenantId) {
  if (!createdBy || createdBy === "unknown") return createdBy;
  const user = await User.findOne({ userId: createdBy, tenantId })
    .select("userFullName")
    .lean();
  return user?.userFullName || createdBy;
}

function enrichBatchWithDownloadUrl(batch, expiryMinutes = 60) {
  if (!batch) return batch;

  if (!batch.fileBlobPath || !azureBlob.isConfigured) {
    return { ...batch, fileUrl: null };
  }

  try {
    const sasUrl = azureBlob.generateDownloadUrl(
      batch.fileBlobPath,
      expiryMinutes
    );
    return { ...batch, fileUrl: sasUrl };
  } catch (err) {
    logger.warn({ err: err.message }, "[BatchDetail] SAS URL generation failed");
    return { ...batch, fileUrl: null };
  }
}

export async function createBatchDetail(req, res) {
  try {
    const type = req.body?.type || req.query?.type;
    const batchDate =
      req.body?.batchDate ||
      req.body?.date ||
      req.query?.batchDate ||
      req.query?.date;
    const paymentDate = req.body?.paymentDate || req.query?.paymentDate;
    const referenceNumber =
      req.body?.referenceNumber || req.query?.referenceNumber;
    const description = (
      req.body?.description ||
      req.query?.description ||
      ""
    ).trim();
    const comments = (req.body?.comments || req.query?.comments || "").trim();
    const workLocation =
      (req.body?.workLocation || req.query?.workLocation || "").trim() || null;
    const bank = (req.body?.bank || req.query?.bank || "").trim() || null;

    if (!type)
      return res
        .status(400)
        .json({ success: false, message: "type is required" });
    if (!batchDate)
      return res.status(400).json({
        success: false,
        message: "batchDate (or date) is required",
      });
    if (!paymentDate)
      return res
        .status(400)
        .json({ success: false, message: "paymentDate is required" });
    if (!referenceNumber)
      return res
        .status(400)
        .json({ success: false, message: "referenceNumber is required" });
    if (type === "deduction" && !workLocation)
      return res.status(400).json({
        success: false,
        message: "workLocation is required when type is deduction",
      });
    if (type === "cheque" && !bank)
      return res.status(400).json({
        success: false,
        message: "bank is required when type is cheque",
      });

    const tenantId = req.user?.tenantId || null;
    const createdBy =
      req.user?.userId || req.user?.id || req.user?.sub || "unknown";

    let fileBlobPath = null;
    let fileUrl = null;
    let fileName = null;
    let fileContentType = null;

    if (req.file && req.file.buffer) {
      fileName = req.file.originalname || "file";
      fileContentType = req.file.mimetype || "application/octet-stream";
      if (azureBlob.isConfigured) {
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        const blobPath = `batch-details/${tenantId || "default"}/${uuidv4()}-${safeName}`;
        fileUrl = await azureBlob.uploadToBlob(
          blobPath,
          req.file.buffer,
          fileContentType
        );
        fileBlobPath = blobPath;
      }
    }

    const batch = await BatchDetail.create({
      tenantId,
      type,
      batchDate: new Date(batchDate),
      paymentDate: new Date(paymentDate),
      workLocation,
      bank,
      batchStatus: "pending",
      referenceNumber: referenceNumber.trim(),
      description,
      comments,
      fileBlobPath,
      fileUrl,
      fileName,
      fileContentType,
      createdBy,
    });

    if (req.file && req.file.buffer) {
      try {
        await batchPaymentProcess.processBatchDetailWithBuffer(
          batch,
          req.file.buffer,
          tenantId
        );
      } catch (err) {
        logger.error(
          { err: err.message },
          "[BatchDetail] file processing error"
        );
        const saved = await BatchDetail.findById(batch._id).lean();
        const createdByName = await resolveCreatedByName(
          saved.createdBy,
          tenantId
        );
        const data = enrichBatchWithDownloadUrl({
          ...saved,
          createdBy: createdByName,
        });
        return res.status(201).json({
          message: "Batch is created. File processing failed: " + err.message,
          data,
        });
      }
    }

    const saved = await BatchDetail.findById(batch._id).lean();
    const createdByName = await resolveCreatedByName(saved.createdBy, tenantId);
    const data = enrichBatchWithDownloadUrl({
      ...saved,
      createdBy: createdByName,
    });
    return res.status(201).json({
      message: "Batch is created.",
      data,
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] create error");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create batch",
    });
  }
}

export async function getBatchDetailById(req, res) {
  try {
    const { batchDetailId } = req.params;
    const batch = await BatchDetail.findOne({
      _id: batchDetailId,
      isDeleted: false,
    })
      .populate(batchPaymentsProfilePopulate())
      .lean();
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch detail not found" });
    }
    const tenantId = req.user?.tenantId || null;
    const createdByName = await resolveCreatedByName(batch.createdBy, tenantId);
    const data = enrichBatchWithDownloadUrl({
      ...batch,
      createdBy: createdByName,
    });
    return res.json({ data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function getAllBatchDetails(req, res) {
  try {
    if (req.user?.userType !== "CRM") {
      return res.status(403).json({
        success: false,
        message: "Only CRM users can access batch details",
      });
    }

    const tenantId = req.user?.tenantId || null;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = (page - 1) * limit;

    const query = { isDeleted: false };
    if (tenantId) query.tenantId = tenantId;

    if (req.query.type) {
      const validTypes = ["cheque", "deduction", "other"];
      if (validTypes.includes(req.query.type)) query.type = req.query.type;
    }

    const [batches, total] = await Promise.all([
      BatchDetail.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BatchDetail.countDocuments(query),
    ]);

    const creatorIds = [
      ...new Set(batches.map((b) => b.createdBy).filter(Boolean)),
    ];
    const users = await User.find({
      userId: { $in: creatorIds },
      tenantId,
    })
      .select("userId userFullName")
      .lean();
    const userMap = new Map(users.map((u) => [u.userId, u.userFullName]));
    const batchesWithCreatorName = batches.map((b) => ({
      ...b,
      createdBy: userMap.get(b.createdBy) || b.createdBy,
    }));

    const batchesWithDownloadUrl = batchesWithCreatorName.map((b) =>
      enrichBatchWithDownloadUrl(b)
    );

    return res.json({
      data: batchesWithDownloadUrl,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] list error");
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function resolveBatchException(req, res) {
  try {
    if (req.user?.userType !== "CRM") {
      return res.status(403).json({
        success: false,
        message: "Only CRM users can resolve batch exceptions",
      });
    }

    const { batchDetailId } = req.params;
    const { membershipNumber, exceptionMembershipNumber } = req.body || {};
    const tenantId = req.user?.tenantId || null;

    const membershipNumberTrimmed =
      membershipNumber != null ? String(membershipNumber).trim() : "";
    const exceptionRefTrimmed =
      exceptionMembershipNumber != null
        ? String(exceptionMembershipNumber).trim()
        : "";

    if (!membershipNumberTrimmed) {
      return res.status(400).json({
        success: false,
        message:
          "membershipNumber is required (correct profile membership number)",
      });
    }
    if (!exceptionRefTrimmed) {
      return res.status(400).json({
        success: false,
        message:
          "exceptionMembershipNumber is required (reference number from batch exception row)",
      });
    }

    const batch = await BatchDetail.findOne({
      _id: batchDetailId,
      isDeleted: false,
    });
    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Batch not found. Please check the batch ID.",
      });
    }

    const exceptions = batch.batchExceptions || [];
    const matchingExceptions = exceptions.filter(
      (ex) => String(ex.membershipNumber || "").trim() === exceptionRefTrimmed
    );
    if (matchingExceptions.length === 0) {
      return res.status(404).json({
        success: false,
        message: `There is no member with this membership number in batch exceptions. No exception found for "${exceptionRefTrimmed}".`,
      });
    }

    const { profile, lookupError } = await findProfileByMembershipNumber(
      membershipNumberTrimmed,
      tenantId
    );
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: lookupError,
      });
    }

    batch.batchPayments = batch.batchPayments || [];
    for (const exceptionRow of matchingExceptions) {
      const fileRow = {
        membershipNumber: exceptionRow.membershipNumber,
        lastName: exceptionRow.lastName,
        firstName: exceptionRow.firstName,
        fullName: exceptionRow.fullName,
        valueForPeriodSelected: exceptionRow.valueForPeriodSelected,
        rowIndex: exceptionRow.rowIndex,
      };
      const paymentEntry =
        batchPaymentProcess.buildBatchPaymentEntryFromProfile(profile, fileRow);
      batch.batchPayments.push(paymentEntry);
    }

    batch.batchExceptions = exceptions.filter(
      (ex) => String(ex.membershipNumber || "").trim() !== exceptionRefTrimmed
    );
    await batch.save();

    const updated = await BatchDetail.findById(batch._id)
      .populate(batchPaymentsProfilePopulate())
      .lean();

    const createdByName = await resolveCreatedByName(
      updated.createdBy,
      tenantId
    );

    const count = matchingExceptions.length;
    const data = enrichBatchWithDownloadUrl({
      ...updated,
      createdBy: createdByName,
    });
    return res.status(200).json({
      message:
        count === 1
          ? "Batch exception resolved; 1 row moved to batch payment"
          : `Batch exception resolved; ${count} rows moved to batch payment`,
      data,
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] resolveBatchException");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to resolve batch exception",
    });
  }
}

export async function addPaymentToBatch(req, res) {
  try {
    if (req.user?.userType !== "CRM") {
      return res.status(403).json({
        success: false,
        message: "Only CRM users can add payments to batch details",
      });
    }

    const { batchDetailId } = req.params;
    const { membershipNumber, memberName, badgeReferenceNumber, amount } =
      req.body || {};
    const tenantId = req.user?.tenantId || null;

    const membershipNumberTrimmed =
      membershipNumber != null ? String(membershipNumber).trim() : "";
    const memberNameTrimmed =
      memberName != null ? String(memberName).trim() : "";
    const badgeRefTrimmed =
      badgeReferenceNumber != null
        ? String(badgeReferenceNumber).trim()
        : "";
    const amountNum =
      amount != null && amount !== "" ? Number(amount) : null;

    if (!membershipNumberTrimmed) {
      return res.status(400).json({
        success: false,
        message: "membershipNumber is required",
      });
    }
    if (!memberNameTrimmed) {
      return res
        .status(400)
        .json({ success: false, message: "memberName is required" });
    }
    if (!badgeRefTrimmed) {
      return res.status(400).json({
        success: false,
        message: "badgeReferenceNumber is required",
      });
    }
    if (amountNum == null || !Number.isFinite(amountNum)) {
      return res.status(400).json({
        success: false,
        message:
          "amount is required and must be a valid number (in Euro, same as in file)",
      });
    }

    const amountInCents = Math.round(amountNum * 100);

    const batch = await BatchDetail.findOne({
      _id: batchDetailId,
      isDeleted: false,
    });
    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Batch detail not found. Please check the batch ID.",
      });
    }

    const batchRefTrimmed = String(batch.referenceNumber || "").trim();
    if (batchRefTrimmed !== badgeRefTrimmed) {
      return res.status(400).json({
        success: false,
        message:
          "Badge reference number does not match this batch. The membership number, badge reference number, and batch ID must belong to the same batch.",
      });
    }

    const { profile, lookupError } = await findProfileByMembershipNumber(
      membershipNumberTrimmed,
      tenantId
    );
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: lookupError,
      });
    }

    const fileRow = {
      membershipNumber: membershipNumberTrimmed,
      lastName: null,
      firstName: null,
      fullName: memberNameTrimmed,
      valueForPeriodSelected: amountInCents,
      rowIndex: 0,
    };

    const paymentEntry =
      batchPaymentProcess.buildBatchPaymentEntryFromProfile(profile, fileRow);
    batch.batchPayments = batch.batchPayments || [];
    batch.batchPayments.push(paymentEntry);
    await batch.save();

    const updated = await BatchDetail.findById(batch._id)
      .populate(batchPaymentsProfilePopulate())
      .lean();

    const createdByName = await resolveCreatedByName(
      updated.createdBy,
      tenantId
    );

    const data = enrichBatchWithDownloadUrl({
      ...updated,
      createdBy: createdByName,
    });
    return res.status(200).json({
      message: "Payment added to batch successfully.",
      data,
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] addPaymentToBatch");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to add payment to batch",
    });
  }
}

export async function processBatchDetail(req, res) {
  try {
    if (req.user?.userType !== "CRM") {
      return res.status(403).json({
        success: false,
        message: "Only CRM users can process batch details",
      });
    }

    const { batchDetailId } = req.params;
    const batch = await BatchDetail.findOne({
      _id: batchDetailId,
      isDeleted: false,
    }).lean();
    if (!batch) {
      return res
        .status(404)
        .json({ success: false, message: "Batch detail not found" });
    }

    if (batch.batchStatus === "processed") {
      return res.status(400).json({
        success: false,
        message: "Batch is already processed",
        batchStatus: batch.batchStatus,
      });
    }

    const batchPayments = Array.isArray(batch.batchPayments)
      ? batch.batchPayments
      : [];
    if (batchPayments.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Batch has no batchPayments to process (only batchPayments are processed, not exceptions)",
      });
    }

    const tenantId = req.user?.tenantId || null;
    const userId = req.user?.userId || req.user?.id || req.user?.sub || null;

    await BatchDetail.updateOne(
      { _id: batchDetailId, isDeleted: false },
      { $set: { batchStatus: "processing" } }
    );

    const result = await publisher.publish(
      BATCH_PROCESS_EVENTS.BATCH_PROCESS_REQUESTED,
      {
        batchDetailId,
        tenantId,
        userId,
      },
      {
        tenantId: tenantId || undefined,
        exchange: "batch.events",
        routingKey: BATCH_PROCESS_EVENTS.BATCH_PROCESS_REQUESTED,
        metadata: { service: "account-service", version: "1.0" },
      }
    );

    if (!result.success) {
      await BatchDetail.updateOne(
        { _id: batchDetailId, isDeleted: false },
        { $set: { batchStatus: "pending" } }
      );
      return res.status(503).json({
        success: false,
        message: "Failed to enqueue batch processing. Please try again.",
        details: result.error,
      });
    }

    return res.status(202).json({
      success: true,
      message: "Batch processing started",
      batchId: batchDetailId,
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] processBatchDetail");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to start batch processing",
    });
  }
}
