import { AppError } from "../errors/AppError.js";

const verifyRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req?.ctx?.roles) {
      const authError = AppError.badRequest("Authentication required", {
        authError: true,
        missingRoles: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          authError: authError.authError,
          missingRoles: authError.missingRoles,
        },
      });
    }

    const rolesArray = [...allowedRoles];

    // Check if user has any of the allowed roles
    const result = req.ctx.roles
      .map((role) => rolesArray.includes(role))
      .find((val) => val === true);

    if (!result) {
      const forbiddenError = AppError.badRequest("Insufficient permissions", {
        forbidden: true,
        userRoles: req.ctx.roles,
        requiredRoles: allowedRoles,
      });
      return res.status(forbiddenError.status).json({
        error: {
          message: forbiddenError.message,
          code: forbiddenError.code,
          status: forbiddenError.status,
          forbidden: forbiddenError.forbidden,
          userRoles: forbiddenError.userRoles,
          requiredRoles: forbiddenError.requiredRoles,
        },
      });
    }

    next();
  };
};

export default verifyRoles;
