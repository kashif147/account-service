import { AppError } from "../errors/AppError.js";

export default function zodValidate(zSchema) {
  return (req, res, next) => {
    const result = zSchema.safeParse({
      ...req.body,
      ...req.params,
      ...req.query,
    });
    if (result.success) {
      req.validated = result.data;
      return next();
    }
    const formatted = result.error.issues.map((i) => ({
      field: i.path.join("."),
      msg: i.message,
    }));
    return res.appError(
      AppError.badRequest("Validation failed", { details: formatted })
    );
  };
}
