import { asyncHandler } from "../helpers/asyncHandler.js";
import {
  applyMemberCreditToInvoices,
  reverseMemberReceipt,
  reverseMemberWriteOff,
  addWriteOffRecoveryNote,
} from "../services/memberCreditOperations.service.js";

export const applyMemberCreditHandler = asyncHandler(async (req, res) => {
  const { date, docNo, memberId, amount, memo } = req.body;
  const result = await applyMemberCreditToInvoices({
    date,
    docNo,
    memberId,
    amount: Math.round(Number(amount)),
    userId: req.ctx?.userId,
    memo,
  });
  res.created(result);
});

export const reverseReceiptHandler = asyncHandler(async (req, res) => {
  const { receiptDocNo, reversalDocNo, memberId, memo } = req.body;
  const result = await reverseMemberReceipt({
    receiptDocNo,
    reversalDocNo,
    memberId,
    userId: req.ctx?.userId,
    memo,
  });
  res.created(result);
});

export const reverseWriteOffHandler = asyncHandler(async (req, res) => {
  const { writeOffDocNo, reversalDocNo, memberId, memo } = req.body;
  const result = await reverseMemberWriteOff({
    writeOffDocNo,
    reversalDocNo,
    memberId,
    userId: req.ctx?.userId,
    memo,
  });
  res.created(result);
});

export const writeOffRecoveryNoteHandler = asyncHandler(async (req, res) => {
  const { writeOffDocNo, note, memberId } = req.body;
  const result = await addWriteOffRecoveryNote({
    writeOffDocNo,
    note,
    memberId,
  });
  res.success(result);
});
