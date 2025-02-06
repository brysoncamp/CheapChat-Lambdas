import AWS from "aws-sdk";
import OpenAI from "openai";

const secretsManager = new AWS.SecretsManager();
let cachedApiKey = null;
const apiGateway = new AWS.ApiGatewayManagementApi({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});

// 🔹 Active connections map for tracking running requests
const activeConnections = new Map();

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

  const { connectionId, message, action } = event; // ✅ Extract action (could be 'cancel')
  if (!connectionId) {
    return { statusCode: 400, body: "Invalid request: Missing connectionId" };
  }

  // ✅ Handle cancellation request
  if (action === "cancel") {
    if (activeConnections.has(connectionId)) {
      activeConnections.set(connectionId, { canceled: true });
      console.log(`🔴 Canceling active request for connection ${connectionId}`);
    }
    return { statusCode: 200, body: "Processing canceled" };
  }

  if (!message) {
    return { statusCode: 400, body: "Invalid request: Missing message" };
  }

  try {
    console.log(`🔹 Sending message to OpenAI: ${message}`);
    const apiKey = await getOpenAIKey();
    const openai = new OpenAI({ apiKey });

    // ✅ Track connection to allow cancellation
    activeConnections.set(connectionId, { canceled: false });

    // ✅ Timeout handling (trigger timeout warning if exceeding 25s)
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve("timeout"), 25000)
    );

    // ✅ OpenAI Streaming Request
    const responsePromise = openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
      stream: true,
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);

    if (response === "timeout") {
      console.log(`⚠️ Timeout reached for connection ${connectionId}`);
      await apiGateway.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({ timeout: true }),
      }).promise();
      activeConnections.delete(connectionId);
      return { statusCode: 408, body: "Timeout reached" };
    }

    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);

    // ✅ Process OpenAI Streaming
    for await (const chunk of response) {
      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) {
        // ✅ Stop sending messages if the user cancels
        if (activeConnections.get(connectionId)?.canceled) {
          console.log(`🛑 Stopped streaming for connection ${connectionId}`);
          break;
        }
        await apiGateway.postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text }),
        }).promise();
      }
    }

    // ✅ If request wasn't canceled, send "done"
    if (!activeConnections.get(connectionId)?.canceled) {
      await apiGateway.postToConnection({
        ConnectionId: connectionId,
        Data: JSON.stringify({ done: true }),
      }).promise();
    }

    // ✅ Cleanup connection tracking
    activeConnections.delete(connectionId);

    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };

  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    return { statusCode: 500, body: "Error contacting OpenAI" };
  }
};
