import { ZodError } from "zod";
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export function publicError(error: unknown) {
  if (error instanceof DomainError)
    return { error: error.message, code: error.code };
  if (error instanceof ZodError)
    return {
      error: error.issues.map((i) => i.message).join("; "),
      code: "VALIDATION",
    };
  throw error;
}
