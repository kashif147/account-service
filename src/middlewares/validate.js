// import { validationResult } from "express-validator";

// export default function validate(req, res, next) {
//   const result = validationResult(req);
//   if (result.isEmpty()) return next();
//   const errors = result.array().map((e) => ({ field: e.param, msg: e.msg }));
//   return res.status(422).json({ errors });
// }

import { validationResult } from "express-validator";
import { AppError } from "../errors/AppError.js";

export default function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = result.array({ onlyFirstError: true }).map((e) => ({
    field: e.param || null,
    msg: e.msg || "Invalid value",
    value: e.value,
  }));

  const validationError = AppError.badRequest("Validation failed", {
    details: errors,
  });
  return res.appError(validationError);
}
