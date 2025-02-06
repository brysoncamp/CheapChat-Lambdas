import AWS from "aws-sdk";
import OpenAI from "openai";

const secretsManager = new AWS.SecretsManager();
let cachedApiKey = null;
const apiGateway = new AWS.ApiGatewayManagementApi({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

// ✅ Fetch OpenAI API Key (cached)
const getOpenAIKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  try {
    const data = await secretsManager.getSecretValue({ SecretId: "OpenAISecrets" }).promise();
    cachedApiKey = JSON.parse(data.SecretString).OPENAI_API_KEY;
    return cachedApiKey;
  } catch (error) {
    console.error("❌ Error retrieving API Key:", error);
    throw new Error("Failed to retrieve OpenAI API Key");
  }
};

export const handler = async (event) => {
  console.log("🟢 OpenAI Handler Event:", JSON.stringify(event, null, 2));

  const { connectionId, sessionId, message } = event;
  if (!connectionId || !sessionId) {
    return { statusCode: 400, body: "Invalid request: Missing connectionId or sessionId" };
  }

  try {
    console.log(`🔹 Sending message to OpenAI: ${message}`);
    const apiKey = await getOpenAIKey();
    const openai = new OpenAI({ apiKey });

    let isCanceled = false; // ✅ Store cancellation status in memory

    // ✅ Separate Cancellation Check Loop (runs every second)
    const checkCancellation = async () => {
      while (!isCanceled) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // ✅ Check every 1s

        const checkResult = await dynamoDB.get({
          TableName: CONNECTIONS_TABLE,
          Key: { sessionId },
        }).promise();

        if (checkResult.Item?.canceled) {
          isCanceled = true;
        }
      }
    };

    // ✅ Start cancellation check in parallel
    checkCancellation();

    // ✅ OpenAI Streaming Request
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
      stream: true,
    });

    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);

    // ✅ Process OpenAI Streaming
    for await (const chunk of response) {
      if (isCanceled) {
        console.log(`🛑 Canceled streaming for session ${sessionId}`);
        await apiGateway.postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify({ canceled: true }),
        }).promise();
        break;
      }

      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) {
        await apiGateway.postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text }),
        }).promise();
      }
    }

    // ✅ If request wasn't canceled, send "done"
    if (!isCanceled) {
      await apiGateway.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({ done: true }),
      }).promise();
    }

    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };

  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    return { statusCode: 500, body: "Error contacting OpenAI" };
  }
};
