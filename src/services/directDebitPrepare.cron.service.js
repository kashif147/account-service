import DirectDebitRun from "../models/directDebitRun.model.js";
import logger from "../config/logger.js";
import { publishDomainEvent } from "../rabbitMQ/index.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_STUCK_AFTER_MS = 10 * 60 * 1000; // 10 minutes

let timer = null;
let isRunning = false;

/**
 * Sweep: any DD prepare job stuck in `queued` or `running` past the timeout is
 * marked failed (process probably crashed). User can re-trigger Prepare.
 */
async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const stuckAfterMs = Math.max(
      60_000,
      parseInt(process.env.DD_PREPARE_STUCK_AFTER_MS || "", 10) ||
        DEFAULT_STUCK_AFTER_MS,
    );
    const cutoff = new Date(Date.now() - stuckAfterMs);

    const stuck = await DirectDebitRun.find({
      $or: [
        { "prepareJob.status": "queued", "prepareJob.queuedAt": { $lt: cutoff } },
        { "prepareJob.status": "running", "prepareJob.startedAt": { $lt: cutoff } },
      ],
    })
      .select("_id tenantId runNo prepareJob createdBy")
      .lean();

    for (const run of stuck) {
      const errMsg = `Prepare timed out after ${Math.round(stuckAfterMs / 1000)}s; worker did not finish`;
      await DirectDebitRun.updateOne(
        { _id: run._id, "prepareJob.status": { $in: ["queued", "running"] } },
        {
          $set: {
            "prepareJob.status": "failed",
            "prepareJob.completedAt": new Date(),
            "prepareJob.errorMessage": errMsg,
            "prepareJob.progress.phase": "failed",
          },
          $push: {
            auditTrail: {
              at: new Date(),
              action: "PREPARE_TIMED_OUT",
              actorId: run.prepareJob?.requestedBy || run.createdBy || null,
              details: { runNo: run.runNo, error: errMsg },
            },
          },
        },
      );
      try {
        await publishDomainEvent(
          "batch.process.completed.v1",
          {
            kind: "DD_PREPARE",
            batchDetailId: String(run._id),
            runId: String(run._id),
            runNo: run.runNo,
            tenantId: run.tenantId,
            userId: run.prepareJob?.requestedBy || run.createdBy,
            createdBy: run.createdBy,
            batchName: `DD run ${run.runNo}`,
            referenceNumber: run.runNo,
            status: "failed",
            message: errMsg,
            processedTransactions: 0,
            totalTransactions: 0,
            failedTransactions: 0,
          },
          {
            tenantId: run.tenantId || undefined,
            exchange: "batch.events",
            routingKey: "batch.process.completed.v1",
            metadata: { service: "account-service", version: "1.0" },
          },
        );
      } catch (err) {
        logger.warn(
          { runId: String(run._id), err: err.message },
          "[DDPrepareCron] failed to publish timeout event",
        );
      }
      logger.warn(
        { runId: String(run._id), runNo: run.runNo, stuckAfterMs },
        "[DDPrepareCron] marked stuck prepare job as failed",
      );
    }
  } catch (error) {
    logger.error({ err: error.message }, "[DDPrepareCron] tick failed");
  } finally {
    isRunning = false;
  }
}

export function startDirectDebitPrepareCron() {
  if (timer) return;
  const intervalMs = Math.max(
    1000,
    parseInt(process.env.DD_PREPARE_CRON_INTERVAL_MS || "", 10) ||
      DEFAULT_INTERVAL_MS,
  );
  timer = setInterval(tick, intervalMs);
  logger.info({ intervalMs }, "[DDPrepareCron] started");
}

export function stopDirectDebitPrepareCron() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info("[DDPrepareCron] stopped");
}
