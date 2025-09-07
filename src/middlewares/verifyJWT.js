// import jwt from "jsonwebtoken";
// import { AppError } from "../errors/AppError.js";

// const verifyJWT = (req, res, next) => {
//   const header = req.headers.authorization || req.headers.Authorization;
//   if (!header?.startsWith("Bearer ")) {
//     const authError = AppError.badRequest("Authorization header required", {
//       tokenError: true,
//       missingHeader: true,
//     });
//     return res.status(authError.status).json({
//       error: {
//         message: authError.message,
//         code: authError.code,
//         status: authError.status,
//         tokenError: authError.tokenError,
//         missingHeader: authError.missingHeader,
//       },
//     });
//   }

//   const token = header.split(" ")[1];

//   jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
//     if (err) {
//       console.error("JWT Verification Error:", err.message);
//       const authError = AppError.badRequest("Invalid token", {
//         tokenError: true,
//         jwtError: err.message,
//       });
//       return res.status(authError.status).json({
//         error: {
//           message: authError.message,
//           code: authError.code,
//           status: authError.status,
//           tokenError: authError.tokenError,
//           jwtError: authError.jwtError,
//         },
//       });
//     }

//     req.user = {
//       id: decoded.id,
//       role: decoded.role,
//       tenantId: decoded.tenantId,
//     };
//     req.tenantId = decoded.tenantId;
//     next();
//   });
// };

// export default verifyJWT;
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

    // Validate tenantId is present in token (using tid, not tenantId)
    if (!decoded.tid) {
      const authError = AppError.badRequest("Invalid token: missing tenantId", {
        tokenError: true,
        missingTenantId: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          missingTenantId: authError.missingTenantId,
        },
      });
    }

    // Set request context with tenant isolation
    req.ctx = {
      tenantId: decoded.tid,
      userId: decoded.sub || decoded.id, // Support both sub and id claims
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };

    // Attach user info to request for backward compatibility
    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = decoded.tid;

    next();
  });
};

export default verifyJWT;
