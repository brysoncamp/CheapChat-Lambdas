import { calculateCost, estimateCost } from "/opt/nodejs/openAICost.mjs";
import { getOpenAIResponse, processOpenAIStream } from "/opt/nodejs/openAIHelper.mjs";
import { getRecentMessages, getNextMessageIndex } from "/opt/nodejs/messagesHelper.mjs";
import { getOpenAIKey } from "/opt/nodejs/openAIKey.mjs";
import { startTimeout, checkCancellation } from "/opt/nodejs/statusHelper.mjs";
import { sendMessage } from "/opt/nodejs/apiGateway.mjs";
import { putDynamoItem } from "/opt/nodejs/dynamoDB/putDynamo.mjs";

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE_NAME;

export const handler = async (event) => {
  console.log("🟢 OpenAI Handler Event:", JSON.stringify(event, null, 2));

  const { action, connectionId, sessionId, message, conversationId } = event;
  if (!action || !connectionId || !sessionId || !message || !conversationId) {
    return {
      statusCode: 400, 
      body: "Invalid request: Missing parameters",
    };
  }

  try {
    const messages = await getRecentMessages(MESSAGES_TABLE, conversationId, message, 5);
    const apiKey = await getOpenAIKey();

    const statusFlags = { isCanceled: false, timeoutTriggered: false };
    const timeout = startTimeout(statusFlags, 60000);
    checkCancellation(CONNECTIONS_TABLE, statusFlags);

    const response = await getOpenAIResponse(apiKey, action, messages);
    const { promptTokens, completionTokens, receivedUsage, fullResponse } = await processOpenAIStream(response, connectionId, sessionId, statusFlags);

    clearTimeout(timeout);

    if (!statusFlags.timeoutTriggered && !statusFlags.isCanceled) {
      await sendMessage(connectionId, { done: true });
    }

    let cost;
    if (receivedUsage) {
      cost = calculateCost(promptTokens, completionTokens, action);
    } else {
      cost = estimateCost(messages, fullResponse, action);
    }
    
    const messageIndex = getNextMessageIndex(MESSAGES_TABLE, conversationId);

    const messageItem = {
      conversationId,
      messageIndex,
      query: message,
      response: fullResponse,
      model: action,
      cost: cost
    };

    console.log("Message Item:", messageItem);
    
    await putDynamoItem(MESSAGES_TABLE, messageItem);

    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };
  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    return {
      statusCode: 500,
      body: "Error contacting OpenAI or reading the stream",
    };
  }
};
