import BatchDetail from "../models/batch.detail.model.js";
import { runBatchProcessing } from "./batch.process.job.service.js";
import logger from "../config/logger.js";

const DEFAULT_INTERVAL_MS = 30 * 1000;

let timer = null;
let isRunning = false;

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const inProgressBatch = await BatchDetail.findOne({
      isDeleted: false,
      batchStatus: "processing_in_progress",
    })
      .select("_id")
      .lean();

    if (inProgressBatch) return;

    const nextQueuedBatch = await BatchDetail.findOneAndUpdate(
      {
        isDeleted: false,
        batchStatus: "queued",
      },
      {
        $set: { batchStatus: "processing_in_progress" },
      },
      {
        sort: { createdAt: 1 },
        new: true,
      }
    )
      .select("_id tenantId")
      .lean();

    if (!nextQueuedBatch) return;

    const batchId = String(nextQueuedBatch._id);
    const result = await runBatchProcessing(batchId, nextQueuedBatch.tenantId || null, {
      alreadyClaimed: true,
    });
    if (!result.success) {
      logger.warn(
        { batchDetailId: batchId, message: result.message },
        "[BatchCron] batch processing failed"
      );
    }
  } catch (error) {
    logger.error({ err: error.message }, "[BatchCron] tick failed");
  } finally {
    isRunning = false;
  }
}

export function startBatchProcessingCron() {
  if (timer) return;
  const intervalMs = Math.max(
    1000,
    parseInt(process.env.BATCH_PROCESS_CRON_INTERVAL_MS || "", 10) ||
      DEFAULT_INTERVAL_MS
  );
  timer = setInterval(tick, intervalMs);
  logger.info({ intervalMs }, "[BatchCron] started");
}

export function stopBatchProcessingCron() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info("[BatchCron] stopped");
}
