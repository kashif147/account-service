/**
 * Parse PAIN.002 XML (minimal DOM-less parser for testability and runtime).
 */

function textBetween(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function allBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[0]);
  }
  return out;
}

function amountFromTxBlock(txBlock) {
  const raw = textBetween(txBlock, "InstdAmt");
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function amountsRoughlyEqual(a, b, tolerance = 0.01) {
  if (a == null || b == null) return true;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

export function parsePain002Xml(xml) {
  const originalMsgId = textBetween(xml, "OrgnlMsgId");
  const grpSts = textBetween(xml, "GrpSts");
  const fileRejectCode =
    grpSts === "RJCT" ? textBetween(xml, "StsRsnInf") : null;
  let groupReasonCode = null;
  if (grpSts === "RJCT") {
    const grpBlock = allBlocks(xml, "OrgnlGrpInfAndSts")[0] || xml;
    groupReasonCode = textBetween(grpBlock, "Cd");
  }

  const transactions = [];
  for (const pmtBlock of allBlocks(xml, "OrgnlPmtInfAndSts")) {
    const orgnlPmtInfId = textBetween(pmtBlock, "OrgnlPmtInfId");
    for (const txBlock of allBlocks(pmtBlock, "TxInfAndSts")) {
      transactions.push({
        orgnlEndToEndId: textBetween(txBlock, "OrgnlEndToEndId"),
        orgnlInstrId: textBetween(txBlock, "OrgnlInstrId"),
        orgnlPmtInfId,
        txSts: textBetween(txBlock, "TxSts"),
        reasonCode: textBetween(txBlock, "Cd"),
        amount: amountFromTxBlock(txBlock),
        reqdColltnDt: textBetween(txBlock, "ReqdColltnDt"),
        stsId: textBetween(txBlock, "StsId"),
      });
    }
  }

  return {
    pain002MsgId: textBetween(xml, "MsgId"),
    originalMsgId,
    fileRejected: grpSts === "RJCT",
    fileRejectCode: groupReasonCode || fileRejectCode,
    transactions: transactions.filter((t) => t.orgnlEndToEndId || t.txSts),
  };
}

function itemEndToEndId(item) {
  return item?.collection?.endToEndId || item?.endToEndId || "";
}

function matchItemToPain002Tx(item, tx, runPaymentInformationId) {
  const e2e = itemEndToEndId(item);
  if (e2e && e2e === tx.orgnlEndToEndId) return true;
  if (tx.orgnlInstrId && e2e === tx.orgnlInstrId) return true;

  const itemPmtInf = item.pain008?.pmtInfId;
  const pmtInfMatch =
    (tx.orgnlPmtInfId &&
      (itemPmtInf === tx.orgnlPmtInfId ||
        runPaymentInformationId === tx.orgnlPmtInfId)) ||
    false;

  if (pmtInfMatch && amountsRoughlyEqual(tx.amount, item.amountEur)) {
    return true;
  }

  if (
    pmtInfMatch &&
    tx.orgnlEndToEndId &&
    item.mandateSnapshot?.umr &&
    amountsRoughlyEqual(tx.amount, item.amountEur)
  ) {
    return true;
  }

  return false;
}

/**
 * Match PAIN.002 rejects to run items.
 * Uses EndToEndId, PmtInfId, amount, and UMR context.
 */
export function matchPain002ToItems(
  parsed,
  items,
  { collectionDate, receivedDate, runPaymentInformationId } = {},
) {
  const collectionD = collectionDate ? new Date(collectionDate) : null;
  const receivedD = receivedDate ? new Date(receivedDate) : new Date();
  let phase = "post_settlement";
  if (collectionD) {
    const dMinus1 = new Date(collectionD);
    dMinus1.setDate(dMinus1.getDate() - 1);
    if (receivedD <= dMinus1) phase = "pre_settlement";
  }

  const matches = [];
  const unmatched = [];
  const matchedItemIds = new Set();

  for (const tx of parsed.transactions) {
    if (tx.txSts && tx.txSts !== "RJCT") continue;

    const item = items.find(
      (i) =>
        !matchedItemIds.has(String(i._id)) &&
        matchItemToPain002Tx(i, tx, runPaymentInformationId),
    );

    if (!item) {
      unmatched.push(tx);
      continue;
    }

    matchedItemIds.add(String(item._id));
    matches.push({
      itemId: item._id?.toString?.() || item.id,
      endToEndId: itemEndToEndId(item),
      reasonCode: tx.reasonCode,
      amountEur: Number(tx.amount) || item.amountEur,
      umr: item.mandateSnapshot?.umr,
      pmtInfId: tx.orgnlPmtInfId || item.pain008?.pmtInfId,
      settlementPhase: phase,
      pain002MsgId: parsed.pain002MsgId,
    });
  }

  return {
    matches,
    unmatched,
    fileRejected: parsed.fileRejected,
    fileRejectCode: parsed.fileRejectCode,
  };
}
