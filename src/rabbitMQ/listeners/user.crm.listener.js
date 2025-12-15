import User from "../../models/user.model.js";
import logger from "../../config/logger.js";

/**
 * Handle CRM user created event
 */
export async function handleCrmUserCreated(payload) {
  const { data } = payload;
  const { userId, userEmail, userFullName, tenantId } = data;

  if (!userId || !tenantId) {
    logger.warn(
      { payload },
      "Invalid CRM user created event: missing userId or tenantId"
    );
    return;
  }

  try {
    await User.findOneAndUpdate(
      { tenantId, userId },
      {
        userId,
        userEmail: userEmail || null,
        userFullName: userFullName || null,
        tenantId,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    logger.info(
      { userId, tenantId, userEmail },
      "CRM user created/updated in account-service"
    );
  } catch (error) {
    logger.error(
      { error: error.message, userId, tenantId },
      "Error handling CRM user created event"
    );
    throw error;
  }
}

/**
 * Handle CRM user updated event
 */
export async function handleCrmUserUpdated(payload) {
  const { data } = payload;
  const { userId, userEmail, userFullName, tenantId } = data;

  if (!userId || !tenantId) {
    logger.warn(
      { payload },
      "Invalid CRM user updated event: missing userId or tenantId"
    );
    return;
  }

  try {
    await User.findOneAndUpdate(
      { tenantId, userId },
      {
        userEmail: userEmail || null,
        userFullName: userFullName || null,
        updatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    logger.info(
      { userId, tenantId, userEmail },
      "CRM user updated in account-service"
    );
  } catch (error) {
    logger.error(
      { error: error.message, userId, tenantId },
      "Error handling CRM user updated event"
    );
    throw error;
  }
}






