/**
 * Member credit reporting events are superseded by journal.created.v1 → reporting_db.gl_journal_entry.
 */
export async function publishMemberCreditReportingEvent() {
  return false;
}
