import AWS from "aws-sdk";

const lambda = new AWS.Lambda();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

export const handler = async (event) => {
  console.log("🟢 WebSocket Message Event:", JSON.stringify(event, null, 2));

  // 1️⃣ Extract sessionId, action, and message directly from `event`
  const { sessionId, action, message } = event;

  if (!sessionId || !message || !action) {
    console.error("❌ Missing sessionId, message, or action");
    return { statusCode: 400, body: "Invalid request: Missing sessionId, message, or action" };
  }

  // 2️⃣ Retrieve `connectionId` from DynamoDB using `sessionId`
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

  // 3️⃣ Define routing logic
  const lambdaFunctionMap = {
    openai: "openAIHandler",
  };

  const functionName = lambdaFunctionMap[action];

  if (!functionName) {
    console.error(`❌ Unknown action: ${action}`);
    return { statusCode: 400, body: `Unsupported action: ${action}` };
  }

  try {
    console.log(`🔹 Forwarding message to ${functionName}...`);
    const payload = { connectionId, message };

    await lambda.invoke({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: JSON.stringify(payload),
    }).promise();

    console.log(`✅ Message forwarded to ${functionName} with connectionId: ${connectionId}`);

    return { statusCode: 200, body: `Message forwarded to ${functionName}` };
  } catch (error) {
    console.error("❌ Error routing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
};
