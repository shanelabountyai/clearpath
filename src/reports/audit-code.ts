/**
 * What an audit reason looks like when it is a code (`leave:returned`), not
 * free text. Only a code may travel in a URL — a row links it, and the audit
 * filter accepts nothing else (PRD 1, Q3; hard rule 3).
 */
export const AUDIT_CODE = /^[a-z_]+:[\w-]+$/;

export const auditCodeOrNothing = (s: string | null | undefined) => (s && AUDIT_CODE.test(s) ? s : undefined);
