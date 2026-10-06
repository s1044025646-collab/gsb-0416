export type ErrorCode =
  | "INVALID_CAPACITY"
  | "INVALID_SEED"
  | "INVALID_BATCH_ID"
  | "INVALID_PAYLOAD"
  | "BATCH_TOO_LARGE"
  | "BATCH_EMPTY"
  | "BATCH_CONFLICT"
  | "COUNT_LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "INTERNAL";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
  }
}
