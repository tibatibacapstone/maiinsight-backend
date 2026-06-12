import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const validRoles = new Set(["marketing", "management", "it_support"]);

export const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Authentication token required" });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);

    if (!validRoles.has(payload.role)) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole || !allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: "Unauthorized access" });
    }
    return next();
  };
};
