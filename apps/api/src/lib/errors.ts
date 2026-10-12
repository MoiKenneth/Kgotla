/** An error that is safe to show to the caller. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Sign in to continue') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You are not allowed to do this') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Not found') => new AppError(404, 'not_found', what);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const locked = (msg: string) => new AppError(423, 'locked', msg);
