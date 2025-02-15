import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

/*import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";*/

import { calculateCost, estimateCost } from "/opt/nodejs/openAICost.mjs";
import { getOpenAIResponse, processOpenAIStream } from "/opt/nodejs/openAIHelper.mjs";
import { getRecentMessages } from "/opt/nodejs/messagesHelper.mjs";

// Initialize AWS Clients
const secretsManager = new SecretsManagerClient({});
const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});

// const dynamoDB = new DynamoDBClient({});

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE_NAME;

// Fetch OpenAI API Key (cached)
let cachedApiKey = null;
const getOpenAIKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  try {
    const data = await secretsManager.send(new GetSecretValueCommand({ SecretId: "OpenAISecrets" }));
    cachedApiKey = JSON.parse(data.SecretString).OPENAI_API_KEY;
    return cachedApiKey;
  } catch (error) {
    console.error("❌ Error retrieving API Key:", error);
    throw new Error("Failed to retrieve OpenAI API Key");
  }
};

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

    /*
    const { Items: recentMessages = [] } = await dynamoDB.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "conversationId = :conversationId",
      ExpressionAttributeValues: {
        ":conversationId": conversationId
      },
      ScanIndexForward: false, // Get the latest messages first
      Limit: 5
    }));
    
    // ✅ Ensure we have a safe array and reverse for correct order
    const messages = [];
    for (const msg of recentMessages.reverse()) { 
      if (msg.query) messages.push({ role: "user", content: msg.query });
      if (msg.response) messages.push({ role: "assistant", content: msg.response });
    }
    
    // ✅ Always add the new user message
    messages.push({ role: "user", content: message });

    // const messages = await getRecentMessages(conversationId, message, 5);



    
    */



    
    console.log("🟢 Final messages array:", messages);

    console.log(`🔹 Sending message to OpenAI: ${message}`);
    const apiKey = await getOpenAIKey();
    //const openai = new OpenAI({ apiKey });

    let isCanceled = false;
    let timeoutTriggered = false;
    const timeoutMs = 60000;

    // ✅ Start a separate timeout that marks the request as timed out
    const timeout = setTimeout(async () => {
      console.log(`⚠️ Timeout reached for connection ${connectionId}`);
      timeoutTriggered = true;
    }, timeoutMs);

    // ✅ Separate Cancellation Check Loop
    const checkCancellation = async () => {
      while (!isCanceled && !timeoutTriggered) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        try {
          const checkResult = await dynamoDB.send(new GetCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { sessionId },
          }));

          if (checkResult.Item?.canceled) {
            isCanceled = true;
          }
        } catch (err) {
          console.error(`❌ Error checking session cancellation: ${err.message}`);
        }
      }
    };

    // ✅ Start cancellation check in parallel
    checkCancellation();

    const response = await getOpenAIResponse(apiKey, action, messages);



    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);

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

      if (timeoutTriggered || isCanceled) {
        console.log(`🛑 Stopping streaming for session ${sessionId}`);

        if (isCanceled) {
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

        if (timeoutTriggered) {
          await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({ timeout: true }),
          }));
        }

        break;
      }

      // console.log("Open AI Chunk:", chunk); // ✅ Log the chunk for debugging

      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) {
        await apiGateway.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text }),
        }));
        fullResponse += text;
      }
    }

    // ✅ Clear timeout if OpenAI finished before 60s
    clearTimeout(timeout);

    // ✅ If request wasn't canceled, send "done"
    if (!timeoutTriggered && !isCanceled) {
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
