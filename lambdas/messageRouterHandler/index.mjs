import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

// ✅ Initialize AWS Clients
const lambda = new LambdaClient({});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});

export const handler = async (event) => {
  console.log("🟢 WebSocket Message Event:", JSON.stringify(event, null, 2));

  const { sessionId, action, message } = event;

  if (!sessionId || !action) {
    console.error("❌ Missing sessionId or action");
    return { statusCode: 400, body: "Invalid request: Missing sessionId or action" };
  }

  // ✅ 1. Get WebSocket `connectionId` from sessionId
  let connectionId;
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
    const conversationId = result.Item.conversationId;
    console.log(`✅ Retrieved connectionId: ${connectionId} for sessionId: ${sessionId}`);

    await apiGateway.send(new PostToConnectionCommand({
      ConnectionI: connectionId, // ✅ Correct placement
      Data: JSON.stringify({ conversationId: conversationId }) // ✅ Send only conversationId inside Data
    }));


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
    openai: "openAIHandler",
    perplexity: "perplexityHandler"
  };

  const functionName = lambdaFunctionMap[action];

  if (!functionName) {
    console.error(`❌ Unknown action: ${action}`);
    return { statusCode: 400, body: `Unsupported action: ${action}` };
  }

  try {
    console.log(`🔹 Forwarding message to ${functionName}...`);
    const payload = { connectionId, message, sessionId };

    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    console.log(`✅ Message forwarded to ${functionName}`);
    return { statusCode: 200, body: `Message forwarded to ${functionName}` };
  } catch (error) {
    console.error("❌ Error routing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
};