import BatchDetail from "../models/batch.detail.model.js";
import { runProcessDeductionBatchPayments } from "../controllers/journal.controller.js";
import logger from "../config/logger.js";

const PROCESS_BATCH_CHUNK_SIZE =
  parseInt(process.env.PROCESS_BATCH_CHUNK_SIZE, 10) || 250;

/**
 * Background job: process batch detail chunks via in-process journal posting.
 */
export async function runBatchProcessing(
  batchDetailId,
  tenantId = null,
  _options = {}
) {
  const batch = await BatchDetail.findOne({
    _id: batchDetailId,
    isDeleted: false,
  }).lean();
  if (!batch) {
    return { success: false, message: "Batch detail not found" };
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
      { $set: { batchStatus: "failed" } }
    );
    return { success: false, message: "Batch has no batchPayments to process" };
  }

  const chunkSize = Math.max(1, PROCESS_BATCH_CHUNK_SIZE);
  const allResults = [];
  const allErrors = [];
  let totalProcessed = 0;
  let totalFailed = 0;

  const paymentDate =
    batch.paymentDate instanceof Date
      ? batch.paymentDate
      : new Date(batch.paymentDate);

  try {
    for (let offset = 0; offset < batchPayments.length; offset += chunkSize) {
      const chunk = batchPayments.slice(offset, offset + chunkSize);
      let result;
      try {
        result = await runProcessDeductionBatchPayments(paymentDate, chunk);
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
    }

    await BatchDetail.updateOne(
      { _id: batchDetailId, isDeleted: false },
      { $set: { batchStatus: "processed" } }
    );

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
}
