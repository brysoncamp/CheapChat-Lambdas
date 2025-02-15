import { queryLatestDynamo } from "/opt/nodejs/dynamoDB/openAIHelper.mjs";

export const getRecentMessages = async (tableName, conversationId, message, limit = 5) => {
  const recentMessages = await queryLatestDynamo(tableName, "conversationId = :conversationId", { ":conversationId": conversationId }, limit);

  const messages = [];

  for (const msg of recentMessages.reverse()) { 
    if (msg.query) messages.push({ role: "user", content: msg.query });
    if (msg.response) messages.push({ role: "assistant", content: msg.response });
  }
  
  messages.push({ role: "user", content: message });

  return messages;
};