import { prisma } from "../config/prisma.js";

export async function logActivity(req, action, metadata = {}) {
  const userId = req.user?.userId;

  if (!userId) {
    return null;
  }

  return prisma.activityLog.create({
    data: {
      userId,
      action,
      metadata: {
        route: req.originalUrl,
        method: req.method,
        role: req.user?.role,
        ...metadata,
      },
    },
  });
}

export async function logItSupportActivity(req, action, metadata = {}) {
  if (req.user?.role !== "it_support") {
    return null;
  }

  return logActivity(req, action, {
    purpose: "technical_troubleshooting",
    auditRequired: true,
    businessAuthority: false,
    ...metadata,
  });
}

// Login happens before the `authenticate` middleware runs, so there is no
// `req.user` yet to read the actor from. This logs against the just-verified
// user record directly instead.
export async function logAuthActivity(user, req, action, metadata = {}) {
  if (!user?.id) {
    return null;
  }

  return prisma.activityLog.create({
    data: {
      userId: user.id,
      action,
      metadata: {
        route: req.originalUrl,
        method: req.method,
        role: user.role,
        ...metadata,
      },
    },
  });
}
