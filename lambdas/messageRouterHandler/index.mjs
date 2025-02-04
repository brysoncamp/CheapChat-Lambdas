import AWS from "aws-sdk";

const lambda = new AWS.Lambda();

export const handler = async (event) => {
  console.log("🟢 WebSocket Message Event:", JSON.stringify(event, null, 2));

  // 1️⃣ Extract connection ID safely
  const connectionId = event.requestContext?.connectionId;

  // 2️⃣ Ensure event.body exists before parsing
  if (!event.body) {
    console.error("❌ event.body is undefined, cannot parse JSON");
    return { statusCode: 400, body: "Invalid request: Missing body" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (error) {
    console.error("❌ JSON parsing error:", error);
    return { statusCode: 400, body: "Invalid JSON format" };
  }

  // 3️⃣ Extract message & action
  const { action, message } = body;

  if (!message || !action || !connectionId) {
    console.error("❌ Invalid message format or missing connectionId");
    return { statusCode: 400, body: "Invalid message format or missing connectionId" };
  }

  // 4️⃣ Define routing logic
  const lambdaFunctionMap = {
    openai: "openAIHandler",
    other: "otherAIHandler", // Example: Future AI integration
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
