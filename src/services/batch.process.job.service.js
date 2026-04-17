import BatchDetail from "../models/batch.detail.model.js";
import { runProcessBatchPayments } from "../controllers/journal.controller.js";
import logger from "../config/logger.js";
import { publisher } from "../rabbitMQ/index.js";

const PROCESS_BATCH_CHUNK_SIZE =
  parseInt(process.env.PROCESS_BATCH_CHUNK_SIZE, 10) || 250;

async function publishBatchProgressEvent({
  eventType,
  tenantId,
  batchDetailId,
  queuedBy,
  createdBy,
  batchName,
  referenceNumber,
  description,
  payload,
}) {
  try {
    const resolvedTenantId = tenantId || null;
    const targetUserId = queuedBy || createdBy || null;
    await publisher.publish(
      eventType,
      {
        batchDetailId,
        tenantId: resolvedTenantId,
        userId: targetUserId,
        createdBy: createdBy || null,
        batchName: batchName || null,
        referenceNumber: referenceNumber || null,
        description: description || null,
        ...payload,
      },
      {
        tenantId: resolvedTenantId || undefined,
        exchange: "batch.events",
        routingKey: eventType,
        metadata: { service: "account-service", version: "1.0" },
      }
    );
  } catch (err) {
    logger.warn(
      { batchDetailId, eventType, err: err.message },
      "[BatchProcessJob] failed to publish event"
    );
  }
}

/**
 * Background job: process batch detail chunks via in-process journal posting.
 */
export async function runBatchProcessing(
  batchDetailId,
  tenantId = null,
  options = {}
) {
  const alreadyClaimed = options?.alreadyClaimed === true;
  const batch = alreadyClaimed
    ? await BatchDetail.findOne({
        _id: batchDetailId,
        isDeleted: false,
        batchStatus: "processing_in_progress",
      }).lean()
    : await BatchDetail.findOneAndUpdate(
        {
          _id: batchDetailId,
          isDeleted: false,
          batchStatus: { $in: ["processing", "queued"] },
        },
        {
          $set: {
            batchStatus: "processing_in_progress",
            processingStartedAt: new Date(),
            processingCompletedAt: null,
          },
        },
        { new: true }
      ).lean();

  if (!batch) {
    const current = await BatchDetail.findOne({
      _id: batchDetailId,
      isDeleted: false,
    })
      .select("batchStatus")
      .lean();
    if (!current) {
      return { success: false, message: "Batch detail not found" };
    }
    if (current.batchStatus === "processed") {
      return {
        success: true,
        message: "Batch was already processed",
        processed: 0,
        failed: 0,
      };
    }
    return {
      success: false,
      message: `Batch is not ready for processing (status: ${current.batchStatus})`,
      processed: 0,
      failed: 0,
    };
  }
  if (batch.batchStatus === "processed") {
    return {
      success: true,
      message: "Batch was already processed",
      processed: 0,
      failed: 0,
    };
  }

  const batchPayments = Array.isArray(batch.batchPayments)
    ? batch.batchPayments
    : [];
  if (batchPayments.length === 0) {
    await BatchDetail.updateOne(
      { _id: batchDetailId, isDeleted: false },
      {
        $set: {
          batchStatus: "failed",
          processingCompletedAt: new Date(),
          totalTransactions: 0,
          processedTransactions: 0,
          failedTransactions: 0,
        },
      }
    );
    await publishBatchProgressEvent({
      eventType: "batch.process.completed.v1",
      tenantId: tenantId || batch.tenantId || null,
      batchDetailId,
      queuedBy: batch.queuedBy,
      createdBy: batch.createdBy,
      batchName: batch.description || "",
      referenceNumber: batch.referenceNumber || "",
      description: batch.description || "",
      payload: {
        status: "failed",
        processedTransactions: 0,
        failedTransactions: 0,
        totalTransactions: 0,
        message: "Batch has no batchPayments to process",
      },
    });
    return { success: false, message: "Batch has no batchPayments to process" };
  }

  const chunkSize = Math.max(1, PROCESS_BATCH_CHUNK_SIZE);
  const allResults = [];
  const allErrors = [];
  let totalProcessed = 0;
  let totalFailed = 0;
  const totalTransactions = batchPayments.length;

  if (alreadyClaimed) {
    await BatchDetail.updateOne(
      { _id: batchDetailId, isDeleted: false },
      {
        $set: {
          processingStartedAt: new Date(),
          processingCompletedAt: null,
        },
      }
    );
  }

  const paymentDate =
    batch.paymentDate instanceof Date
      ? batch.paymentDate
      : new Date(batch.paymentDate);

  try {
    for (let offset = 0; offset < batchPayments.length; offset += chunkSize) {
      const chunk = batchPayments.slice(offset, offset + chunkSize);
      let result;
      try {
        result = await runProcessBatchPayments(
          paymentDate,
          chunk,
          batch.type,
          {
            batchName: batch.description || "",
            referenceNumber: batch.referenceNumber || "",
          }
        );
      } catch (err) {
        const errMsg = err.message || String(err);
        logger.error(
          { batchDetailId, err: errMsg },
          "[BatchProcessJob] runProcessDeductionBatchPayments failed"
        );
        await BatchDetail.updateOne(
          { _id: batchDetailId, isDeleted: false },
          { $set: { batchStatus: "failed" } }
        );
        return {
          success: false,
          message: errMsg,
          processed: totalProcessed,
          failed: totalFailed,
          errors: allErrors.length ? allErrors : undefined,
        };
      }

      totalProcessed += result.processed ?? 0;
      totalFailed += result.failed ?? 0;
      if (Array.isArray(result.results)) allResults.push(...result.results);
      if (Array.isArray(result.errors)) allErrors.push(...result.errors);

      await BatchDetail.updateOne(
        { _id: batchDetailId, isDeleted: false },
        {
          $set: {
            totalTransactions,
            processedTransactions: totalProcessed,
            failedTransactions: totalFailed,
          },
        }
      );

      await publishBatchProgressEvent({
        eventType: "batch.process.progress.v1",
        tenantId: tenantId || batch.tenantId || null,
        batchDetailId,
        queuedBy: batch.queuedBy,
        createdBy: batch.createdBy,
        batchName: batch.description || "",
        referenceNumber: batch.referenceNumber || "",
        description: batch.description || "",
        payload: {
          status: "processing_in_progress",
          processedTransactions: totalProcessed,
          failedTransactions: totalFailed,
          totalTransactions,
        },
      });
    }

    await BatchDetail.updateOne(
      { _id: batchDetailId, isDeleted: false },
      {
        $set: {
          batchStatus: "processed",
          processingCompletedAt: new Date(),
          totalTransactions,
          processedTransactions: totalProcessed,
          failedTransactions: totalFailed,
        },
      }
    );

    await publishBatchProgressEvent({
      eventType: "batch.process.completed.v1",
      tenantId: tenantId || batch.tenantId || null,
      batchDetailId,
      queuedBy: batch.queuedBy,
      createdBy: batch.createdBy,
      batchName: batch.description || "",
      referenceNumber: batch.referenceNumber || "",
      description: batch.description || "",
      payload: {
        status: "processed",
        processedTransactions: totalProcessed,
        failedTransactions: totalFailed,
        totalTransactions,
      },
    });

    return {
      success: true,
      processed: totalProcessed,
      failed: totalFailed,
      results: allResults,
      errors: allErrors.length ? allErrors : undefined,
    };
  } catch (error) {
    const errMsg = error.message || String(error);
    logger.error({ batchDetailId, err: errMsg }, "[BatchProcessJob] error");
    await BatchDetail.updateOne(
      { _id: batchDetailId, isDeleted: false },
      {
        $set: {
          batchStatus: "failed",
          processingCompletedAt: new Date(),
          totalTransactions,
          processedTransactions: totalProcessed,
          failedTransactions: totalFailed,
        },
      }
    );

    await publishBatchProgressEvent({
      eventType: "batch.process.completed.v1",
      tenantId: tenantId || batch.tenantId || null,
      batchDetailId,
      queuedBy: batch.queuedBy,
      createdBy: batch.createdBy,
      batchName: batch.description || "",
      referenceNumber: batch.referenceNumber || "",
      description: batch.description || "",
      payload: {
        status: "failed",
        processedTransactions: totalProcessed,
        failedTransactions: totalFailed,
        totalTransactions,
        message: errMsg,
      },
    });
    return {
      success: false,
      message: errMsg,
      processed: totalProcessed,
      failed: totalFailed,
      errors: allErrors.length ? allErrors : undefined,
    };
  }
}
