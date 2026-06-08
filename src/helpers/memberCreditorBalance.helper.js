/**
 * Member balance from GL signed amounts (debits − credits per account).
 *
 * Irish membership / charity accounting alignment:
 * - 1400 Accounts Receivable — Members: positive = member owes the organisation.
 * - 2020 Payment on Account (Member Credits): negative = prepayment / available credit
 *   (organisation liability to the member), per platform finance policy.
 *
 * Combined net = ar1400 + poa2020:
 * - net > 0  → member is a debtor (organisation receivable)
 * - net < 0  → member is a creditor (organisation owes the member)
 *
 * Creditors list amount = −net when net < 0 (e.g. overpayment on 2020, approved CN credit).
 */
export function computeMemberBalanceFromGl({ ar1400 = 0, poa2020 = 0 } = {}) {
  const ar = Number(ar1400) || 0;
  const poa = Number(poa2020) || 0;
  const net = ar + poa;
  return {
    ar1400: ar,
    poa2020: poa,
    net,
    amountCents: net < 0 ? -net : 0,
    debtorCents: net > 0 ? net : 0,
  };
}

export function isMemberCreditorBalance({ ar1400 = 0, poa2020 = 0 } = {}) {
  return computeMemberBalanceFromGl({ ar1400, poa2020 }).amountCents > 0;
}
