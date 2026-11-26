// Tiny HTTP error type for route handlers.
export class HttpError extends Error {
  constructor(public readonly status: number, message?: string) {
    super(message ?? defaultMessage(status));
    this.name = "HttpError";
  }
}

function defaultMessage(status: number): string {
  return status === 401 ? "Not signed in" : status === 403 ? "Not allowed" : status === 400 ? "Bad request" : "Error";
}

/** Turn anything thrown in a handler into a JSON response. Unknown errors are 500 without detail. */
export function toResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}
