// One error type with a stable machine-readable `code` clients can branch on.
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_CURSOR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly issues?: readonly FieldIssue[];
  /** True for anything the caller can fix by changing the request. */
  readonly expected: boolean;

  constructor(params: {
    status: number;
    code: ErrorCode;
    message: string;
    issues?: readonly FieldIssue[];
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'AppError';
    this.status = params.status;
    this.code = params.code;
    if (params.issues !== undefined) this.issues = params.issues;
    this.expected = params.status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, issues?: readonly FieldIssue[]): AppError =>
  new AppError({ status: 400, code: 'VALIDATION_FAILED', message, ...(issues ? { issues } : {}) });

export const invalidCursor = (message = 'The cursor is not valid.'): AppError =>
  new AppError({ status: 400, code: 'INVALID_CURSOR', message });

export const unauthenticated = (message = 'Authentication is required.'): AppError =>
  new AppError({ status: 401, code: 'UNAUTHENTICATED', message });

export const forbidden = (message = 'You are not allowed to access this resource.'): AppError =>
  new AppError({ status: 403, code: 'FORBIDDEN', message });

export const notFound = (message = 'Resource not found.'): AppError =>
  new AppError({ status: 404, code: 'NOT_FOUND', message });
