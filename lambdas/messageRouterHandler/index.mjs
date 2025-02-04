import AWS from "aws-sdk";

const lambda = new AWS.Lambda();

export const handler = async (event) => {
  console.log("WebSocket Message Event:", JSON.stringify(event, null, 2));

  // 1️⃣ Extract connection ID & message
  const connectionId = event.requestContext?.connectionId; // ✅ Ensure connectionId exists
  const body = JSON.parse(event.body);
  const { action, message } = body;

  if (!message || !action || !connectionId) {
    console.error("❌ Invalid message format or missing connectionId");
    return { statusCode: 400, body: "Invalid message format or missing connectionId" };
  }

  // 2️⃣ Define routing logic based on "action" field
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
    // 3️⃣ Forward message & connectionId to the appropriate Lambda function
    const payload = { connectionId, message };

    await lambda.invoke({
      FunctionName: functionName,
      InvocationType: "Event", // Asynchronous execution
      Payload: JSON.stringify(payload),
    }).promise();

    console.log(`✅ Message forwarded to ${functionName} with connectionId: ${connectionId}`);

    return { statusCode: 200, body: `Message forwarded to ${functionName}` };
  } catch (error) {
    console.error("❌ Error routing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
};
