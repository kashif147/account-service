import mongoose from "mongoose";
import Payment from "../models/payment.model.js";
import Refund from "../models/refund.model.js";
import CreditNote from "../models/creditNote.model.js";
import DirectDebitMandate from "../models/directDebitMandate.model.js";
import DirectDebitRunItem from "../models/directDebitRunItem.model.js";
import JournalAdjustment from "../models/journalAdjustment.model.js";
import { AppError } from "../errors/AppError.js";

function expandMemberIdKeys(memberId) {
  const raw = memberId != null ? String(memberId).trim() : "";
  if (!raw) return [];
  const noSpaces = raw.replace(/\s+/g, "");
  const upper = noSpaces.toUpperCase();
  const alnumOnly = upper.replace(/[^A-Z0-9]/g, "");
  return [...new Set([raw, noSpaces, upper, alnumOnly].filter(Boolean))];
}

export async function profileMergeReassignHandler(req, res, next) {
  try {
    const tenantId = req.tenantId || req.headers["x-tenant-id"];
    if (!tenantId) {
      return next(AppError.badRequest("Tenant context is required"));
    }

    const {
      masterProfileId,
      absorbedProfileId,
      masterMembershipNumber,
      absorbedMembershipNumber,
    } = req.body || {};

    if (!masterProfileId || !absorbedProfileId) {
      return next(
        AppError.badRequest("masterProfileId and absorbedProfileId are required"),
      );
    }
    if (String(masterProfileId) === String(absorbedProfileId)) {
      return next(AppError.badRequest("Cannot merge a profile with itself"));
    }

    const absorbedMemberKeys = expandMemberIdKeys(absorbedMembershipNumber);
    const masterMemberId =
      masterMembershipNumber != null ? String(masterMembershipNumber).trim() : "";

    const memberFilter =
      absorbedMemberKeys.length > 0
        ? { tenantId, memberId: { $in: absorbedMemberKeys } }
        : null;

    let paymentsUpdated = 0;
    let refundsUpdated = 0;
    let creditNotesUpdated = 0;
    let mandatesUpdated = 0;
    let ddRunItemsUpdated = 0;
    let journalAdjustmentsUpdated = 0;

    if (memberFilter && masterMemberId) {
      const paymentResult = await Payment.updateMany(memberFilter, {
        $set: { memberId: masterMemberId },
      });
      paymentsUpdated = paymentResult.modifiedCount || 0;

      const refundResult = await Refund.updateMany(memberFilter, {
        $set: { memberId: masterMemberId },
      });
      refundsUpdated = refundResult.modifiedCount || 0;

      const creditNoteResult = await CreditNote.updateMany(memberFilter, {
        $set: { memberId: masterMemberId },
      });
      creditNotesUpdated = creditNoteResult.modifiedCount || 0;

      const journalResult = await JournalAdjustment.updateMany(memberFilter, {
        $set: { memberId: masterMemberId },
      });
      journalAdjustmentsUpdated = journalResult.modifiedCount || 0;
    }

    const absorbedProfileObjectId = mongoose.Types.ObjectId.isValid(absorbedProfileId)
      ? new mongoose.Types.ObjectId(String(absorbedProfileId))
      : null;
    const masterProfileObjectId = mongoose.Types.ObjectId.isValid(masterProfileId)
      ? new mongoose.Types.ObjectId(String(masterProfileId))
      : null;

    if (absorbedProfileObjectId && masterProfileObjectId) {
      const mandateResult = await DirectDebitMandate.updateMany(
        { tenantId, profileId: absorbedProfileObjectId },
        {
          $set: {
            profileId: masterProfileObjectId,
            ...(masterMemberId ? { memberId: masterMemberId } : {}),
          },
        },
      );
      mandatesUpdated = mandateResult.modifiedCount || 0;

      const ddItemResult = await DirectDebitRunItem.updateMany(
        { tenantId, profileId: String(absorbedProfileId) },
        {
          $set: {
            profileId: String(masterProfileId),
            ...(masterMemberId ? { memberId: masterMemberId } : {}),
          },
        },
      );
      ddRunItemsUpdated = ddItemResult.modifiedCount || 0;
    }

    return res.success({
      masterProfileId: String(masterProfileId),
      absorbedProfileId: String(absorbedProfileId),
      masterMembershipNumber: masterMemberId || null,
      absorbedMembershipNumber: absorbedMembershipNumber || null,
      paymentsUpdated,
      refundsUpdated,
      creditNotesUpdated,
      mandatesUpdated,
      ddRunItemsUpdated,
      journalAdjustmentsUpdated,
      glTransactionsNote:
        "GL transaction entries are immutable; member history remains auditable under prior memberId keys where already posted.",
    });
  } catch (error) {
    return next(error);
  }
}
