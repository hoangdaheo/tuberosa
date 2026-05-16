export type AppErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'safety_blocked'
  | 'ingestion_limit'
  | 'model_provider_error'
  | 'store_error'
  | 'cache_error'
  | 'internal_error';

export interface AppErrorOptions {
  code: AppErrorCode;
  status: number;
  message: string;
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed.', details?: unknown) {
    super({ code: 'validation_error', status: 400, message, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', details?: unknown) {
    super({ code: 'not_found', status: 404, message, details });
  }
}

export class SafetyBlockedError extends AppError {
  constructor(message = 'Knowledge blocked by safety policy.', details?: unknown) {
    super({ code: 'safety_blocked', status: 400, message, details });
  }
}

export class IngestionLimitAppError extends AppError {
  constructor(message = 'Ingestion limit exceeded.', details?: unknown) {
    super({ code: 'ingestion_limit', status: 413, message, details });
  }
}

export class ModelProviderError extends AppError {
  constructor(message = 'Model provider request failed.', cause?: unknown) {
    super({ code: 'model_provider_error', status: 502, message, cause });
  }
}

export class StoreError extends AppError {
  constructor(message = 'Knowledge store request failed.', cause?: unknown) {
    super({ code: 'store_error', status: 503, message, cause });
  }
}

export class CacheError extends AppError {
  constructor(message = 'Cache request failed.', cause?: unknown) {
    super({ code: 'cache_error', status: 503, message, cause });
  }
}

export interface HttpErrorBody {
  error: string;
  code: AppErrorCode;
  details?: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data: {
    code: AppErrorCode;
    status: number;
    details?: unknown;
  };
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isPgError(error)) {
    return new StoreError(errorMessage(error), error);
  }

  if (isRedisError(error)) {
    return new CacheError(errorMessage(error), error);
  }

  const statusCode = readStatusCode(error);
  if (statusCode !== undefined) {
    return new AppError({
      code: statusCode === 404 ? 'not_found' : statusCode === 413 ? 'ingestion_limit' : 'internal_error',
      status: statusCode,
      message: errorMessage(error),
      cause: error,
    });
  }

  return new AppError({
    code: 'internal_error',
    status: 500,
    message: errorMessage(error) || 'Internal server error.',
    cause: error,
  });
}

export function appErrorToHttpBody(error: AppError): HttpErrorBody {
  return {
    error: error.message,
    code: error.code,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export function appErrorToJsonRpcError(error: unknown): JsonRpcErrorBody {
  const appError = toAppError(error);
  return {
    code: jsonRpcCodeForAppError(appError),
    message: appError.message,
    data: {
      code: appError.code,
      status: appError.status,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };
}

function jsonRpcCodeForAppError(error: AppError): number {
  if (error.code === 'validation_error') {
    return -32602;
  }

  if (error.code === 'not_found') {
    return -32004;
  }

  if (error.code === 'safety_blocked' || error.code === 'ingestion_limit') {
    return -32000;
  }

  return -32603;
}

function readStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isPgError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as { code?: unknown; severity?: unknown; routine?: unknown };
  return typeof record.code === 'string' && (typeof record.severity === 'string' || typeof record.routine === 'string');
}

function isRedisError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name.toLowerCase().includes('redis') || error.message.toLowerCase().includes('redis');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
