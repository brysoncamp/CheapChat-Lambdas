import AWS from "aws-sdk";
import OpenAI from "openai"; // ✅ Correct import for OpenAI SDK

const secretsManager = new AWS.SecretsManager();
let cachedApiKey = null; // 🔹 Cache OpenAI API Key

// ✅ Initialize API Gateway Management for WebSocket Messaging
const apiGateway = new AWS.ApiGatewayManagementApi({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});

// ✅ Fetch Secret (only if not cached)
const getOpenAIKey = async () => {
  if (cachedApiKey) return cachedApiKey;

  console.log("🔄 Fetching OpenAI API Key from Secrets Manager...");
  try {
    const data = await secretsManager.getSecretValue({
      SecretId: "OpenAISecrets"
    }).promise();
    
    cachedApiKey = JSON.parse(data.SecretString).OPENAI_API_KEY; // 🔹 Store in cache
    return cachedApiKey;
  } catch (error) {
    console.error("❌ Error retrieving API Key:", error);
    throw new Error("Failed to retrieve OpenAI API Key");
  }
};

export const handler = async (event) => {
  console.log("OpenAI Handler Event:", JSON.stringify(event, null, 2));

  // ✅ Get cached API key or fetch it if not cached
  const apiKey = await getOpenAIKey();
  const openai = new OpenAI({ apiKey });

  // ✅ Extract connection ID & message
  const { connectionId, message } = JSON.parse(event.body);

  if (!message || !connectionId) {
    console.error("❌ Invalid request: Missing message or connectionId");
    return { statusCode: 400, body: "Invalid request: Missing message or connectionId" };
  }

  try {
    console.log(`🔹 Sending message to OpenAI: ${message}`);

    // ✅ Call OpenAI API with streaming enabled
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
      stream: true, // Enable streaming
    });

    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);

    // ✅ Process OpenAI streaming response
    for await (const chunk of response) {
      const text = chunk.choices?.[0]?.delta?.content || ""; // 🔹 Extract response text

      if (text) {
        await apiGateway.postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text }),
        }).promise();
      }
    }

    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };
  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    return { statusCode: 500, body: "Error contacting OpenAI" };
  }
};
