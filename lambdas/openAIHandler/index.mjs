import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

import { calculateCost, estimateCost } from "/opt/nodejs/openAICost.mjs";
import { getOpenAIResponse, processOpenAIStream } from "/opt/nodejs/openAIHelper.mjs";
import { getRecentMessages } from "/opt/nodejs/messagesHelper.mjs";
import { getOpenAIKey } from "/opt/nodejs/openAIKey.mjs";
import { startTimeout, checkCancellation } from "/opt/nodejs/statusHelper.mjs";

/*const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});*/

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
    const { promptTokens, completionTokens, receivedUsage, fullResponse } = await processOpenAIStream(response, apiGateway, connectionId, statusFlags);

    /*
    let promptTokens = 0;
    let completionTokens = 0;
    let receivedUsage = false;
    let fullResponse = "";

    // ✅ Process OpenAI Streaming

    for await (const chunk of response) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        receivedUsage = true;
      }

      if (statusFlags.timeoutTriggered || statusFlags.isCanceled) {
        console.log(`🛑 Stopping streaming for session ${sessionId}`);

        if (statusFlags.isCanceled) {
          await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({ canceled: true }),
          }));

          await dynamoDB.send(new UpdateCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { sessionId },
            UpdateExpression: "REMOVE canceled",
          }));
        }

        if (statusFlags.timeoutTriggered) {
          await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({ timeout: true }),
          }));
        }

        break;
      }

      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) {
        await apiGateway.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text }),
        }));
        fullResponse += text;
      }
    }*/

    clearTimeout(timeout);

    if (!statusFlags.timeoutTriggered && !statusFlags.isCanceled) {
      await apiGateway.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ done: true }),
      }));
    }

    let cost;

    if (receivedUsage) {
      cost = calculateCost(promptTokens, completionTokens, action);
    } else {
      cost = estimateCost(messages, fullResponse, action);
    }
    
    console.log("--- saving message to dynamo db ---");

    // Determine messageindex 
    const { Items } = await dynamoDB.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "conversationId = :conversationId",
      ExpressionAttributeValues: {
        ":conversationId": conversationId
      },
      ScanIndexForward: false, // Get the latest message first
      Limit: 1
    }));

    const messageIndex = (Items?.length > 0 ? Items[0].messageIndex : -1) + 1;

    console.log("Conversation ID:", conversationId);
    console.log("Message Index:", messageIndex);

    const messageItem = {
      conversationId,
      messageIndex,
      query: message,
      response: fullResponse,
      model: action,
      cost: cost
    };

    console.log("Message Item:", messageItem);
    
    await dynamoDB.send(new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: messageItem,
    }));

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
