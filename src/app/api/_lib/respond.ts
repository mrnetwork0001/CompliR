/**
 * JSON response helpers for CompliR route handlers.
 * Every error body has the shape `{ error: { code, message, details? } }`.
 */

export type ErrorCode =
  | "INVALID_JSON"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "NOT_IMPLEMENTED"
  | "SERVICE_PAUSED"
  | "RATE_LIMITED"
  | "SCREENING_IN_PROGRESS"
  | "INTERNAL_ERROR";

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

const STATUS_FOR: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  NOT_IMPLEMENTED: 501,
  SERVICE_PAUSED: 503,
  RATE_LIMITED: 429,
  SCREENING_IN_PROGRESS: 503,
  INTERNAL_ERROR: 500,
};

/** Throw this anywhere inside a handler wrapped with `handle()` to produce a JSON error. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** extra response headers (e.g. Retry-After on 429/503) */
  readonly headers?: Record<string, string>;
  constructor(code: ErrorCode, message: string, details?: unknown, status?: number, headers?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? STATUS_FOR[code];
    this.details = details;
    this.headers = headers;
  }
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-CompliR-Version": "v1",
};

function withHeaders(init?: ResponseInit): HeadersInit {
  const h = new Headers(BASE_HEADERS);
  if (init?.headers) new Headers(init.headers).forEach((v, k) => h.set(k, v));
  return h;
}

/** 200 (or `init.status`) JSON response. */
export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, { ...init, status: init?.status ?? 200, headers: withHeaders(init) });
}

/** JSON error response. Status defaults from the code. */
export function error(code: ErrorCode, message: string, details?: unknown, init?: ResponseInit): Response {
  const body: ErrorBody = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return Response.json(body, { ...init, status: init?.status ?? STATUS_FOR[code], headers: withHeaders(init) });
}

/** 501 with an echo of the validated body so clients can integrate before the feature lands. */
export function notImplemented(feature: string, echo?: unknown): Response {
  return error("NOT_IMPLEMENTED", `${feature} is not implemented yet. Your request validated; here is what we received.`, echo && { echo });
}

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response> | Response;

/**
 * Wrap a route handler so thrown `ApiError`s become JSON errors and anything else becomes a 500.
 * Keeps the handler signature Next expects: `(request, context) => Response`.
 */
export function handle<Ctx = unknown>(fn: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof ApiError) return error(e.code, e.message, e.details, { status: e.status, headers: e.headers });
      const message = e instanceof Error ? e.message : String(e);
      console.error("[complir/api] unhandled error:", e);
      return error("INTERNAL_ERROR", process.env.NODE_ENV === "production" ? "Internal error" : message);
    }
  };
}
