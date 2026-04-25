export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "HTTP_ERROR",
    public details?: unknown
  ) {
    super(message);
  }
}

export function notFound(resource: string): HttpError {
  return new HttpError(404, `${resource} not found`, "NOT_FOUND");
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, "BAD_REQUEST", details);
}

export function conflict(message: string, details?: unknown): HttpError {
  return new HttpError(409, message, "CONFLICT", details);
}
