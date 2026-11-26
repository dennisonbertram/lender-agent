/** An error that carries the HTTP status and the server's user-facing text. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly stage?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Something went wrong");
  return res.json();
}

/** Retry only when no HTTP answer came back (network); at most twice. A 4xx/5xx is an answer, shown at once. */
export const retryTransient = (n: number, e: unknown) => !(e instanceof ApiError) && n < 2;
