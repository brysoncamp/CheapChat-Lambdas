import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { sendMessage } from "/opt/nodejs/apiGateway.mjs";
import { generateName } from "/opt/nodejs/openAINamer.mjs";

const lambda = new LambdaClient({});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME;
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE_NAME;

const nameConversation = async (message, connectionId) => {
  const { name, cost } = await generateName(message);
  console.log("Name", name);
  console.log("Cost", cost);

  await dynamoDB.send(new UpdateCommand({
    TableName: CONVERSATIONS_TABLE,
    Key: { conversationId }, // Ensure your primary key is "conversationId"
    UpdateExpression: "SET title = :title",
    ExpressionAttributeValues: {
      ":title": name
    }
  }));

  await sendMessage(connectionId, { title: name });

}

export const handler = async (event) => {
  console.log("🟢 WebSocket Message Event:", JSON.stringify(event, null, 2));

  const { sessionId, action, message, conversationId: eventConversationId } = event;

  if (!sessionId || !action) {
    console.error("❌ Missing sessionId or action");
    return { statusCode: 400, body: "Invalid request: Missing sessionId or action" };
  }

  let connectionId;
  let conversationId = eventConversationId;

  let backgroundTasks = [];

  try {
    const result = await dynamoDB.send(
      new GetCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { sessionId },
      })
    );

    if (!result.Item) {
      console.error("❌ No active connection found for sessionId:", sessionId);
      return { statusCode: 404, body: "No active WebSocket connection found" };
    }

    connectionId = result.Item.connectionId;
    if (!conversationId) {
      conversationId = result.Item.conversationId;
      console.log("FIRST MESSGE IN CONVERSATION - GENERATE NAME", conversationId);
      backgroundTasks.push(nameConversation(message, connectionId));
    }
    
    console.log(`✅ Retrieved connectionId: ${connectionId} for sessionId: ${sessionId}`);

    await sendMessage(connectionId, { conversationId });

  } catch (error) {
    console.error("❌ Error fetching connectionId from DynamoDB:", error);
    return { statusCode: 500, body: "Failed to retrieve WebSocket connection" };
  }

  // ✅ 2. Handle CANCEL request before invoking OpenAI Lambda
  if (action === "cancel") {
    console.log(`🚫 Cancel request received for session: ${sessionId}`);

    await dynamoDB.send(
      new UpdateCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { sessionId },
        UpdateExpression: "SET canceled = :canceled",
        ExpressionAttributeValues: { ":canceled": true },
      })
    );

    return { statusCode: 200, body: "Processing canceled" };
  }

  // ✅ 3. Route messages to OpenAI Lambda
  const lambdaFunctionMap = { 
    "gpt-4o": "openAIHandler",
    "gpt-4o-mini": "openAIHandler",
    "o1": "openAIHandler",
    "o1-mini": "openAIHandler",
    "o3-mini": "openAIHandler",
    "chatgpt-4o-latest": "openAIHandler",
    "gpt-4-turbo": "openAIHandler",
    "gpt-4": "openAIHandler",
    "gpt-3.5-turbo": "openAIHandler",
    "sonar-reasoning-pro": "perplexityHandler",
    "sonar-reasoning": "perplexityHandler",
    "sonar-pro": "perplexityHandler",
    "sonar": "perplexityHandler"
  };

  const functionName = lambdaFunctionMap[action];

  if (!functionName) {
    console.error(`❌ Unknown action: ${action}`);
    return { statusCode: 400, body: `Unsupported action: ${action}` };
  }

  try {
    console.log(`🔹 Forwarding message to ${functionName}...`);
    const payload = { action, connectionId, message, sessionId, conversationId };

    backgroundTasks.push(
      lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      )
    );

    await Promise.allSettled(backgroundTasks);

    console.log(`✅ Message forwarded to ${functionName}`);
    return { statusCode: 200, body: `Message forwarded to ${functionName}` };
  } catch (error) {
    console.error("❌ Error routing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
};