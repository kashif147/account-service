import crypto from "crypto";
import {
  escapeXml,
  formatAmount2dp,
  normalizeIban,
  sanitizeMsgId,
  sanitizeSepaText,
  sumAmounts2dp,
} from "../helpers/sepaXml.helper.js";
import { AppError } from "../errors/AppError.js";

const MAX_PMT_INF_BLOCKS = 25;

function blockKey(item) {
  const iban = normalizeIban(item.creditorIban);
  const date = item.reqdColltnDt;
  const seq = item.seqTp || "RCUR";
  return `${iban}|${date}|${seq}`;
}

/**
 * Group included items into PmtInf blocks (creditor IBAN + collection date + SeqTp).
 * @param {object[]} items - frozen snapshots with mandateSnapshot, amountEur, etc.
 * @param {object} creditor - creditorSnapshot from run
 * @param {string} collectionDate - YYYY-MM-DD
 */
export function groupItemsForPain008(items, creditor, collectionDate) {
  const oin = creditor.oin;
  const creditorIban = normalizeIban(creditor.iban);
  const creditorBic = creditor.bic || "AIBKIE2DXXX";
  const creditorName = sanitizeSepaText(creditor.name, 70);

  const groups = new Map();
  for (const item of items) {
    const seqTp = item.mandateSnapshot?.seqTp || "RCUR";
    const key = blockKey({
      creditorIban,
      reqdColltnDt: collectionDate,
      seqTp,
    });
    if (!groups.has(key)) {
      groups.set(key, {
        seqTp,
        pmtInfId: item.pain008?.pmtInfId || null,
        transactions: [],
      });
    }
    groups.get(key).transactions.push({
      ...item,
      seqTp,
      creditorIban,
      creditorBic,
      creditorName,
      oin,
    });
  }

  const blocks = [...groups.values()];
  if (blocks.length > MAX_PMT_INF_BLOCKS) {
    throw AppError.badRequest(
      `PAIN.008 would exceed ${MAX_PMT_INF_BLOCKS} payment blocks (${blocks.length}); split the run`,
    );
  }

  return blocks.map((block, idx) => {
    const amounts = block.transactions.map((t) => t.amountEur);
    const pmtInfId =
      block.pmtInfId ||
      sanitizeSepaText(
        `PMTID.${String(oin || "OIN").slice(-8)}.${collectionDate.replace(/-/g, "")}.${String(idx + 1).padStart(2, "0")}`,
        35,
      );
    return {
      ...block,
      pmtInfId,
      nbOfTxs: block.transactions.length,
      ctrlSum: sumAmounts2dp(amounts),
      creditorIban,
      creditorBic,
      creditorName,
      oin,
      reqdColltnDt: collectionDate,
    };
  });
}

function renderDbtrAgt(bic) {
  const normalized = (bic || "").trim().toUpperCase();
  if (normalized && normalized !== "NOTPROVIDED") {
    return `<DbtrAgt><FinInstnId><BICFI>${escapeXml(normalized)}</BICFI></FinInstnId></DbtrAgt>`;
  }
  return `<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>`;
}

function renderCdtrAgt(bic) {
  const normalized = (bic || "AIBKIE2DXXX").trim().toUpperCase();
  if (normalized && normalized !== "NOTPROVIDED") {
    return `<CdtrAgt><FinInstnId><BICFI>${escapeXml(normalized)}</BICFI></FinInstnId></CdtrAgt>`;
  }
  return `<CdtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></CdtrAgt>`;
}

function renderDrctDbtTxInf(tx, oin) {
  const m = tx.mandateSnapshot || {};
  const signed =
    m.signedDate instanceof Date
      ? m.signedDate.toISOString().slice(0, 10)
      : String(m.signedDate || "").slice(0, 10);
  const town = sanitizeSepaText(m.debtorCity || m.debtorAddress, 35);
  const country = sanitizeSepaText(m.debtorCountry || "IE", 2);
  const remittance = tx.remittanceInfo
    ? `<RmtInf><Ustrd>${escapeXml(sanitizeSepaText(tx.remittanceInfo, 140))}</Ustrd></RmtInf>`
    : "";

  return `<DrctDbtTxInf>
<PmtId><EndToEndId>${escapeXml(sanitizeSepaText(tx.endToEndId, 35))}</EndToEndId></PmtId>
<InstdAmt Ccy="EUR">${formatAmount2dp(tx.amountEur)}</InstdAmt>
<DrctDbtTx>
<MndtRltdInf>
<MndtId>${escapeXml(sanitizeSepaText(m.umr, 35))}</MndtId>
<DtOfSgntr>${escapeXml(signed)}</DtOfSgntr>
<AmdmntInd>false</AmdmntInd>
</MndtRltdInf>
<CdtrSchmeId><Id><PrvtId><Othr><Id>${escapeXml(sanitizeSepaText(oin, 35))}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>
</DrctDbtTx>
${renderDbtrAgt(m.debtorBic)}
<Dbtr><Nm>${escapeXml(sanitizeSepaText(m.debtorName, 70))}</Nm><PstlAdr><TwnNm>${escapeXml(town)}</TwnNm><Ctry>${escapeXml(country)}</Ctry></PstlAdr></Dbtr>
<DbtrAcct><Id><IBAN>${escapeXml(normalizeIban(m.debtorIban))}</IBAN></Id></DbtrAcct>
${remittance}
</DrctDbtTxInf>`;
}

function renderPmtInf(block) {
  const txs = block.transactions.map((t) => renderDrctDbtTxInf(t, block.oin)).join("");
  return `<PmtInf>
<PmtInfId>${escapeXml(block.pmtInfId)}</PmtInfId>
<PmtMtd>DD</PmtMtd>
<NbOfTxs>${block.nbOfTxs}</NbOfTxs>
<CtrlSum>${block.ctrlSum}</CtrlSum>
<PmtTpInf>
<SvcLvl><Cd>SEPA</Cd></SvcLvl>
<LclInstrm><Cd>CORE</Cd></LclInstrm>
<SeqTp>${escapeXml(block.seqTp)}</SeqTp>
</PmtTpInf>
<ReqdColltnDt>${escapeXml(block.reqdColltnDt)}</ReqdColltnDt>
<Cdtr><Nm>${escapeXml(block.creditorName)}</Nm></Cdtr>
<CdtrAcct><Id><IBAN>${escapeXml(block.creditorIban)}</IBAN></Id></CdtrAcct>
${renderCdtrAgt(block.creditorBic)}
<ChrgBr>SLEV</ChrgBr>
${txs}
</PmtInf>`;
}

/**
 * Build PAIN.008.001.08 XML from frozen run items only.
 */
export function buildPain008Xml({ msgId, creDtTm, oin, blocks }) {
  const allTx = blocks.flatMap((b) => b.transactions);
  const headerNb = allTx.length;
  const headerSum = sumAmounts2dp(allTx.map((t) => t.amountEur));

  for (const block of blocks) {
    const blockSum = sumAmounts2dp(block.transactions.map((t) => t.amountEur));
    if (block.ctrlSum !== blockSum) {
      throw AppError.internalServerError(
        `Block ${block.pmtInfId} CtrlSum mismatch`,
      );
    }
    if (block.nbOfTxs !== block.transactions.length) {
      throw AppError.internalServerError(
        `Block ${block.pmtInfId} NbOfTxs mismatch`,
      );
    }
  }

  if (headerNb !== allTx.length) {
    throw AppError.internalServerError("Header NbOfTxs mismatch");
  }

  const pmtInfXml = blocks.map(renderPmtInf).join("");
  const safeMsgId = sanitizeMsgId(msgId);

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<CstmrDrctDbtInitn>
<GrpHdr>
<MsgId>${escapeXml(safeMsgId)}</MsgId>
<CreDtTm>${escapeXml(creDtTm)}</CreDtTm>
<NbOfTxs>${headerNb}</NbOfTxs>
<CtrlSum>${headerSum}</CtrlSum>
<InitgPty><Id><OrgId><Othr><Id>${escapeXml(sanitizeSepaText(oin, 35))}</Id></Othr></OrgId></Id></InitgPty>
</GrpHdr>
${pmtInfXml}
</CstmrDrctDbtInitn>
</Document>`;

  return {
    xml,
    msgId: safeMsgId,
    nbOfTxs: headerNb,
    ctrlSum: headerSum,
    pmtInfIds: blocks.map((b) => b.pmtInfId),
    fileHash: crypto.createHash("sha256").update(xml, "utf8").digest("hex"),
  };
}

export function validatePain008Inputs(creditor) {
  const errors = [];
  if (!creditor?.oin) errors.push({ code: "MISSING_OIN", message: "Creditor OIN is required" });
  if (!creditor?.iban) errors.push({ code: "MISSING_IBAN", message: "Creditor IBAN is required" });
  if (!creditor?.name) errors.push({ code: "MISSING_CREDITOR_NAME", message: "Creditor name is required" });
  return errors;
}
