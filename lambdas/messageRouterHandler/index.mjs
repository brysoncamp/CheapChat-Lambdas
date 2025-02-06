import AWS from "aws-sdk";

const lambda = new AWS.Lambda();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

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
    const result = await dynamoDB
      .get({
        TableName: CONNECTIONS_TABLE,
        Key: { sessionId },
      })
      .promise();

    if (!result.Item) {
      console.error("❌ No active connection found for sessionId:", sessionId);
      return { statusCode: 404, body: "No active WebSocket connection found" };
    }

    connectionId = result.Item.connectionId;
    console.log(`✅ Retrieved connectionId: ${connectionId} for sessionId: ${sessionId}`);
  } catch (error) {
    console.error("❌ Error fetching connectionId from DynamoDB:", error);
    return { statusCode: 500, body: "Failed to retrieve WebSocket connection" };
  }

  // ✅ 2. Handle CANCEL request before invoking OpenAI Lambda
  if (action === "cancel") {
    console.log(`🚫 Cancel request received for session: ${sessionId}`);

    await dynamoDB.update({
      TableName: CONNECTIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: "SET canceled = :canceled",
      ExpressionAttributeValues: { ":canceled": true },
    }).promise();

    return { statusCode: 200, body: "Processing canceled" };
  }

  // ✅ 3. Route messages to OpenAI Lambda
  const lambdaFunctionMap = { openai: "openAIHandler" };
  const functionName = lambdaFunctionMap[action];

  if (!functionName) {
    console.error(`❌ Unknown action: ${action}`);
    return { statusCode: 400, body: `Unsupported action: ${action}` };
  }

  try {
    console.log(`🔹 Forwarding message to ${functionName}...`);
    const payload = { connectionId, message, sessionId };

    await lambda.invoke({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: JSON.stringify(payload),
    }).promise();

    console.log(`✅ Message forwarded to ${functionName}`);
    return { statusCode: 200, body: `Message forwarded to ${functionName}` };
  } catch (error) {
    console.error("❌ Error routing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
};
