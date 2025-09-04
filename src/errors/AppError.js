export class AppError extends Error {
  constructor(message, status = 500, code = "APP_ERROR", extras = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    Object.assign(this, extras);
  }

  static conflict(message = "Version conflict", extras = {}) {
    return new AppError(message, 409, "CONFLICT", extras);
  }

  static notFound(message = "Not found", extras = {}) {
    return new AppError(message, 404, "NOT_FOUND", extras);
  }

  static badRequest(message = "Bad request", extras = {}) {
    return new AppError(message, 400, "BAD_REQUEST", extras);
  }
}
