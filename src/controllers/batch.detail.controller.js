import { v4 as uuidv4 } from "uuid";
import BatchDetail, {
  BATCH_DETAIL_TYPES,
} from "../models/batch.detail.model.js";
import User from "../models/user.model.js";
import { getProfileReadModel } from "../models/profileRead.model.js";
import * as azureBlob from "../services/azure.blob.service.js";
import * as batchPaymentProcess from "../services/batch.payment.process.service.js";
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
      (
        req.body?.workLocation ||
        req.body?.bankName ||
        req.query?.workLocation ||
        ""
      ).trim() || null;
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
    if ((type === "deduction" || type === "Standing Order") && !workLocation)
      return res.status(400).json({
        success: false,
        message:
          "workLocation (or bank name for standing orders) is required for this batch type",
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
          fileContentType,
          fileName
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

export async function deleteBatchDetail(req, res) {
  try {
    const { batchDetailId } = req.params;
    const tenantId = req.user?.tenantId || null;

    const filter = {
      _id: batchDetailId,
      isDeleted: false,
      batchStatus: "pending",
    };
    if (tenantId) filter.tenantId = tenantId;

    // Mongo + Azure cannot share one transaction; we delete Mongo first and restore
    // the full document if blob removal throws (compensating "rollback").
    const deleted = await BatchDetail.findOneAndDelete(filter).lean();

    if (deleted) {
      if (deleted.fileBlobPath && azureBlob.isConfigured) {
        try {
          await azureBlob.deleteBlobIfExists(deleted.fileBlobPath);
        } catch (err) {
          logger.error(
            {
              err: err.message,
              fileBlobPath: deleted.fileBlobPath,
              batchDetailId,
            },
            "[BatchDetail] blob delete failed; restoring batch document"
          );
          try {
            await BatchDetail.collection.insertOne(deleted);
          } catch (restoreErr) {
            logger.error(
              {
                err: restoreErr.message,
                batchDetailId,
              },
              "[BatchDetail] blob delete failed and Mongo restore failed"
            );
            return res.status(500).json({
              success: false,
              message:
                "Deletion could not be completed. The batch record may be missing while the file may still exist; contact support.",
            });
          }
          return res.status(503).json({
            success: false,
            message:
              "File could not be removed from storage. The batch has been restored.",
          });
        }
      }
      return res.status(200).json({
        success: true,
        message: "Batch detail deleted",
      });
    }

    const any = await BatchDetail.findById(batchDetailId)
      .select("isDeleted tenantId batchStatus")
      .lean();
    if (!any || any.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Batch detail not found",
      });
    }
    if (tenantId && any.tenantId !== tenantId) {
      return res.status(404).json({
        success: false,
        message: "Batch detail not found",
      });
    }
    return res.status(400).json({
      success: false,
      message: `Batch can only be deleted while status is pending (current: ${any.batchStatus}).`,
      batchStatus: any.batchStatus,
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] deleteBatchDetail");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete batch detail",
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
      if (BATCH_DETAIL_TYPES.includes(req.query.type)) {
        query.type = req.query.type;
      }
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
    if (
      batch.batchStatus === "queued" ||
      batch.batchStatus === "processing" ||
      batch.batchStatus === "processing_in_progress"
    ) {
      return res.status(400).json({
        success: false,
        message: "Batch is already queued/being processed",
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
      {
        $set: {
          batchStatus: "queued",
          queuedBy: userId,
          queuedAt: new Date(),
          processingStartedAt: null,
          processingCompletedAt: null,
          totalTransactions: batchPayments.length,
          processedTransactions: 0,
          failedTransactions: 0,
        },
      }
    );

    return res.status(202).json({
      success: true,
      message: "Batch queued for processing",
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

export async function getBatchQueueStats(req, res) {
  try {
    if (req.user?.userType !== "CRM") {
      return res.status(403).json({
        success: false,
        message: "Only CRM users can access batch queue stats",
      });
    }

    const tenantId = req.user?.tenantId || null;
    const query = { isDeleted: false };
    if (tenantId) query.tenantId = tenantId;

    const [statusCounts, queueRows, inProgress] = await Promise.all([
      BatchDetail.aggregate([
        { $match: query },
        {
          $group: {
            _id: "$batchStatus",
            count: { $sum: 1 },
          },
        },
      ]),
      BatchDetail.find({ ...query, batchStatus: "queued" })
        .sort({ queuedAt: 1, createdAt: 1 })
        .select(
          "_id referenceNumber type batchStatus queuedAt totalTransactions processedTransactions failedTransactions"
        )
        .lean(),
      BatchDetail.findOne({ ...query, batchStatus: "processing_in_progress" })
        .sort({ processingStartedAt: 1, updatedAt: 1 })
        .select(
          "_id referenceNumber type batchStatus queuedAt processingStartedAt totalTransactions processedTransactions failedTransactions"
        )
        .lean(),
    ]);

    const countsByStatus = Object.fromEntries(
      statusCounts.map((x) => [String(x._id || ""), x.count])
    );

    return res.status(200).json({
      success: true,
      data: {
        queued: countsByStatus.queued || 0,
        processing_in_progress: countsByStatus.processing_in_progress || 0,
        processed: countsByStatus.processed || 0,
        failed: countsByStatus.failed || 0,
        inProgressBatch: inProgress || null,
        queueOrder: queueRows,
      },
    });
  } catch (error) {
    logger.error({ err: error.message }, "[BatchDetail] getBatchQueueStats");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch batch queue stats",
    });
  }
}
