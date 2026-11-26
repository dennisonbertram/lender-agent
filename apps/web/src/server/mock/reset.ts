// `MOCK=1` only: drop the in-memory world (a new PGlite database and new mock services). Used by E2E.
import { setDbForTests } from "@/server/db/client";
import { createMockServices, getServices, setServicesForTests } from "@/server/services";
import { HttpError } from "@/server/http";

export async function resetMockWorld(): Promise<void> {
  if (!getServices().mock) throw new HttpError(404, "Not found");
  setDbForTests(undefined);
  setServicesForTests(createMockServices());
}
