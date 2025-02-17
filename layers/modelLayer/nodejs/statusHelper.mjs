import { getDynamoItem } from "/opt/nodejs/dynamoDB/getDynamo.mjs";

export const startTimeout = (statusFlags, timeoutMs) => {
  return setTimeout(() => {
    statusFlags.timeoutTriggered = true;
  }, timeoutMs);
};

export const checkCancellation = async (tableName, sessionId, statusFlags) => {
  while (!statusFlags.isCanceled && !statusFlags.timeoutTriggered) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const cancelResult = await getDynamoItem(tableName, { sessionId });

    if (cancelResult.canceled) {
      statusFlags.isCanceled = true;
    }
  }
}