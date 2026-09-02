import { guarded } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { clientTarget } from '../clients/repository';
import { csvCell, toCsv } from '../csv';
import { NotFound } from '../errors';
import { addDays, localDateOf, zonedToUtc, type LocalDate } from '../time';
import type { AppointmentType } from '../scheduling/recurrence';

/**
 * The superbill: what a client hands their insurer to claim out-of-network
 * reimbursement themselves.
 *
 * The practice does not bill insurance — that is a clearinghouse integration
 * and a different project. What it owes the client is an accurate receipt: the
 * dates they attended, the service code for each, what they paid, and who
 * rendered it. Everything on it already exists in the record, which is the
 * point; a superbill that had to invent a number would be a superbill nobody
 * should sign.
 */

type Modality = 'in_person' | 'telehealth';

/**
 * CPT service codes, by appointment length. The code is a claim about how long
 * the session was, so it is derived from the appointment type rather than typed
 * by whoever exports it — the two ways to get this wrong are both fraud.
 */
export const CPT: Record<AppointmentType, { code: string; description: string }> = {
  intake: { code: '90791', description: 'Psychiatric diagnostic evaluation' },
  standard: { code: '90834', description: 'Psychotherapy, 45 minutes' },
  extended: { code: '90837', description: 'Psychotherapy, 60 minutes' },
};

export interface ServiceCode {
  code: string;
  description: string;
  /** `95` marks a session delivered by interactive telecommunication. */
  modifier: string | null;
  /** Place of service: 02 telehealth, 11 office. */
  placeOfService: '02' | '11';
}

export function cptFor(type: AppointmentType, modality: Modality): ServiceCode {
  return {
    ...CPT[type],
    modifier: modality === 'telehealth' ? '95' : null,
    placeOfService: modality === 'telehealth' ? '02' : '11',
  };
}

export interface BillableSession {
  startAt: Date;
  type: AppointmentType;
  modality: Modality;
  status: string;
  /** The fee recorded when the session completed, in integer cents. */
  chargeFeeCents: number | null;
  clinicianName: string;
}

export interface SuperbillLine {
  date: LocalDate;
  code: string;
  description: string;
  modifier: string | null;
  placeOfService: string;
  units: 1;
  feeCents: number;
  renderingProvider: string;
}

/**
 * Only sessions that happened.
 *
 * A no-show or a late cancellation carries a fee and belongs on the client's
 * statement, but it is not a service and no insurer reimburses it. Putting one
 * on a superbill is how a practice ends up explaining itself to a payer, so the
 * filter is here, in the pure function, where a test can hold it still.
 */
export function superbillLines(sessions: readonly BillableSession[]): SuperbillLine[] {
  return sessions
    .filter((s) => s.status === 'completed')
    .map((s) => {
      const service = cptFor(s.type, s.modality);
      return {
        date: localDateOf(s.startAt),
        code: service.code,
        description: service.description,
        modifier: service.modifier,
        placeOfService: service.placeOfService,
        units: 1 as const,
        feeCents: s.chargeFeeCents ?? 0,
        renderingProvider: s.clinicianName,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const totalCents = (lines: readonly SuperbillLine[]): number =>
  lines.reduce((sum, l) => sum + l.feeCents, 0);

export interface Superbill {
  client: { id: string; code: string; name: string; dateOfBirth: Date };
  practice: string;
  range: { from: LocalDate; to: LocalDate };
  lines: SuperbillLine[];
  totalCents: number;
  /** Stated on the document rather than left for the client to discover. */
  omissions: string[];
}

/**
 * Build one client's superbill for a date range.
 *
 * Guarded twice, deliberately. The document is a fee record *and* a set of
 * demographics, so producing it needs both permissions and logs both reads. The
 * matrix therefore already answers "who may run billing" without a new rule:
 * front desk always, the treating clinician for their own clients, and the
 * practice manager only through break-glass — because their demographics access
 * is break-glass, and a superbill is not an exception to that.
 */
export async function buildSuperbill(
  actor: Actor,
  clientId: string,
  range: { from: LocalDate; to: LocalDate },
): Promise<Superbill> {
  const target = await clientTarget(clientId);

  return guarded(
    { actor, action: 'read', resource: 'fee', resourceId: clientId, clientId, target },
    (tx) =>
      guarded(
        { actor, action: 'read', resource: 'client', resourceId: clientId, clientId, target },
        async (inner) => {
          const client = await inner.client.findUnique({
            where: { id: clientId },
            select: { id: true, code: true, firstName: true, lastName: true, dateOfBirth: true },
          });
          if (!client) throw new NotFound('Client');

          const settings = await inner.practiceSettings.findUnique({ where: { id: 1 } });

          const sessions = await inner.appointment.findMany({
            where: {
              clientId,
              status: 'completed',
              startAt: { gte: zonedToUtc(range.from, 0), lt: zonedToUtc(addDays(range.to, 1), 0) },
            },
            select: {
              startAt: true, type: true, modality: true, status: true, chargeFeeCents: true,
              clinician: { select: { name: true } },
            },
            orderBy: { startAt: 'asc' },
          });

          const lines = superbillLines(
            sessions.map((s) => ({
              startAt: s.startAt,
              type: s.type,
              modality: s.modality,
              status: s.status,
              chargeFeeCents: s.chargeFeeCents,
              clinicianName: s.clinician.name,
            })),
          );

          return {
            client: {
              id: client.id,
              code: client.code,
              name: `${client.firstName} ${client.lastName}`,
              dateOfBirth: client.dateOfBirth,
            },
            practice: settings?.name ?? 'Stillwater Counseling',
            range,
            lines,
            totalCents: totalCents(lines),
            omissions: OMISSIONS,
          };
        },
        tx,
      ),
  );
}

/**
 * What this document does not carry, said out loud on the document.
 *
 * A superbill without a diagnosis code is not claimable, and Clearpath does not
 * model diagnoses — that is a clinical vocabulary with its own consequences, and
 * inventing a field for it here would produce a form that looks submittable and
 * is not. Saying so on the export is the honest version; silently omitting it
 * sends the client to their insurer with a document that gets rejected.
 */
export const OMISSIONS = [
  'No diagnosis (ICD-10) code: Clearpath does not record diagnoses. Your clinician must add one before this is claimable.',
  'No NPI or tax identification: this is a synthetic-data project, not a billing system.',
  'Payments are not tracked. Amounts shown are the fees recorded at the time of service.',
];

const COLUMNS = [
  'date', 'code', 'description', 'modifier', 'placeOfService', 'units', 'fee', 'renderingProvider',
] as const;

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** CSV of a superbill: the lines, a total row, then the omissions. */
export function superbillCsv(bill: Superbill): string {
  const rows = [
    ...bill.lines.map((l) => ({ ...l, fee: dollars(l.feeCents) })),
    { description: 'TOTAL', fee: dollars(bill.totalCents) },
  ];
  return [toCsv(COLUMNS, rows), '', ...bill.omissions.map(csvCell)].join('\n');
}
