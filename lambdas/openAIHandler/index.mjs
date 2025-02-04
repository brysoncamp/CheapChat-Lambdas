import AWS from "aws-sdk";
import { Configuration, OpenAIApi } from "openai";

const secretsManager = new AWS.SecretsManager();
let cachedApiKey = null; // 🔹 Cached API Key

// ✅ Fetch Secret (only if not cached)
async function getOpenAIKey() {
  if (cachedApiKey) {
    console.log("✅ Using Cached OpenAI API Key");
    return cachedApiKey;
  }

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
}

export async function handler(event) {
  console.log("OpenAI Handler Event:", event);

  // ✅ Get cached API key or fetch it if not cached
  const apiKey = await getOpenAIKey();
  const openai = new OpenAIApi(new Configuration({ apiKey }));

  // 1️⃣ Extract connection ID & message
  const { connectionId, message } = JSON.parse(event.body);
  if (!message) {
    return { statusCode: 400, body: "Invalid request" };
  }

  try {
    // 2️⃣ Call OpenAI API
    const response = await openai.createChatCompletion({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
      stream: true,
    });

    // 3️⃣ Stream OpenAI response back to WebSocket client
    for await (const chunk of response.body) {
      await apiGateway.postToConnection({
        ConnectionId: connectionId,
        Data: chunk,
      }).promise();
    }

    return { statusCode: 200, body: "Response sent to client" };
  } catch (error) {
    console.error("OpenAI API Error:", error);
    return { statusCode: 500, body: "Error contacting OpenAI" };
  }
}
