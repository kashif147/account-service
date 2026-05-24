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
  for (const txBlock of allBlocks(xml, "TxInfAndSts")) {
    transactions.push({
      orgnlEndToEndId: textBetween(txBlock, "OrgnlEndToEndId"),
      orgnlInstrId: textBetween(txBlock, "OrgnlInstrId"),
      orgnlPmtInfId: textBetween(xml, "OrgnlPmtInfId"),
      txSts: textBetween(txBlock, "TxSts"),
      reasonCode: textBetween(txBlock, "Cd"),
      amount: textBetween(txBlock, "InstdAmt"),
      reqdColltnDt: textBetween(txBlock, "ReqdColltnDt"),
      stsId: textBetween(txBlock, "StsId"),
    });
  }

  return {
    pain002MsgId: textBetween(xml, "MsgId"),
    originalMsgId,
    fileRejected: grpSts === "RJCT",
    fileRejectCode: groupReasonCode || fileRejectCode,
    transactions: transactions.filter((t) => t.orgnlEndToEndId || t.txSts),
  };
}

/**
 * Match PAIN.002 rejects to run items.
 */
export function matchPain002ToItems(parsed, items, { collectionDate, receivedDate }) {
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

  for (const tx of parsed.transactions) {
    if (tx.txSts && tx.txSts !== "RJCT") continue;
    const item = items.find(
      (i) =>
        i.endToEndId === tx.orgnlEndToEndId ||
        (tx.orgnlInstrId && i.endToEndId === tx.orgnlInstrId),
    );
    if (!item) {
      unmatched.push(tx);
      continue;
    }
    matches.push({
      itemId: item._id?.toString?.() || item.id,
      endToEndId: item.endToEndId,
      reasonCode: tx.reasonCode,
      amountEur: Number(tx.amount) || item.amountEur,
      umr: item.mandateSnapshot?.umr,
      settlementPhase: phase,
      pain002MsgId: parsed.pain002MsgId,
    });
  }

  return { matches, unmatched, fileRejected: parsed.fileRejected, fileRejectCode: parsed.fileRejectCode };
}
