/**
 * Thrown when the permission matrix denies. Carries no PHI: the message names
 * the resource type and nothing about the person it belongs to.
 */
export class Forbidden extends Error {
  readonly status = 403;
  constructor(
    readonly resource: string,
    readonly action: string,
    /** Set for the process-note rule, which is absolute rather than situational. */
    readonly absolute = false,
  ) {
    super(`Not permitted: ${action} ${resource}`);
    this.name = 'Forbidden';
  }
}

export class NotFound extends Error {
  readonly status = 404;
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFound';
  }
}

/** A business-rule refusal — double booking, late edit of a signed note. */
export class Conflict extends Error {
  readonly status = 409;
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'Conflict';
  }
}
