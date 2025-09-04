import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError.js";

const verifyJWT = (req, res, next) => {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header?.startsWith("Bearer ")) {
    const authError = AppError.badRequest("Authorization header required", {
      tokenError: true,
      missingHeader: true,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        tokenError: authError.tokenError,
        missingHeader: authError.missingHeader,
      },
    });
  }

  const token = header.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error("JWT Verification Error:", err.message);
      const authError = AppError.badRequest("Invalid token", {
        tokenError: true,
        jwtError: err.message,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          jwtError: authError.jwtError,
        },
      });
    }

    req.user = {
      id: decoded.id,
      role: decoded.role,
      tenantId: decoded.tenantId,
    };
    req.tenantId = decoded.tenantId;
    next();
  });
};

export default verifyJWT;
