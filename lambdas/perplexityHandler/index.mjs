import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import axios from "axios"; // ✅ Keep Axios for compatibility

// Initialize AWS Clients
const secretsManager = new SecretsManagerClient({});
const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

// Fetch Perplexity API Key (cached)
let cachedApiKey = null;
const getPerplexityKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  try {
    const data = await secretsManager.send(new GetSecretValueCommand({ SecretId: "PerplexitySecrets" }));
    cachedApiKey = JSON.parse(data.SecretString).PERPLEXITY_API_KEY;
    return cachedApiKey;
  } catch (error) {
    console.error("Error retrieving API Key:", error);
    throw new Error("Failed to retrieve Perplexity API Key");
  }
};

// ✅ Function to handle Perplexity API Request
const fetchPerplexityResponse = async (messages, connectionId, sessionId) => {
  const apiKey = await getPerplexityKey();
  console.log("🔹 Fetching streaming response from Perplexity...");

  try {
    const response = await axios({
      method: "POST",
      url: "https://api.perplexity.ai/chat/completions",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      data: {
        model: "sonar",
        messages: messages,
        stream: true, // ✅ Enable streaming
      },
      responseType: "stream", // ✅ Ensure streaming response
    });

    console.log("✅ Processing streaming response...");

    let buffer = ""; // ✅ Stores incomplete chunks
    let isFirstChunk = true;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    // ✅ Read stream and handle proper chunking
    response.data.on("data", async (chunk) => {
      try {
        const chunkString = chunk.toString(); // ✅ Convert chunk to string
        buffer += chunkString; // ✅ Append to buffer
        console.log("🔹 RAW CHUNK RECEIVED:", chunkString);

        // ✅ Process all complete JSON objects in buffer
        const jsonChunks = buffer.split("\n").filter((line) => line.startsWith("data: "));
        buffer = buffer.endsWith("}") ? "" : buffer; // ✅ Retain last partial chunk

        for (const jsonChunk of jsonChunks) {
          const jsonString = jsonChunk.replace(/^data:\s*/, ""); // Remove "data: "
          try {
            const jsonData = JSON.parse(jsonString);
            console.log("✅ Parsed JSON Data:", JSON.stringify(jsonData, null, 2));

            // ✅ Send citations immediately on first chunk
            if (isFirstChunk && jsonData.citations) {
              console.log("🔹 Sending Citations:", jsonData.citations);
              await apiGateway.send(new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: JSON.stringify({ citations: jsonData.citations }),
              }));
              isFirstChunk = false; // Prevent resending
            }

            // ✅ Extract and send `delta.content` for streamed response
            const text = jsonData.choices?.[0]?.delta?.content || "";
            if (text) {
              console.log("✅ Sending Text:", text);
              await apiGateway.send(new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: JSON.stringify({ text }),
              }));
            }

            // ✅ Extract Token Usage from last chunk
            if (jsonData.usage) {
              console.log("🔹 Token Usage Found:", jsonData.usage);
              promptTokens = jsonData.usage.prompt_tokens;
              completionTokens = jsonData.usage.completion_tokens;
              totalTokens = jsonData.usage.total_tokens;
            }
          } catch (parseError) {
            console.warn("⚠️ JSON Parsing Error, skipping:", jsonChunk);
          }
        }
      } catch (error) {
        console.error("❌ Error processing chunk:", error);
      }
    });

    return new Promise((resolve) => {
      response.data.on("end", async () => {
        console.log("✅ Finished streaming response.");
        console.log(`🟢 Token Usage: Prompt = ${promptTokens}, Completion = ${completionTokens}, Total = ${totalTokens}`);

        await apiGateway.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ token_usage: { promptTokens, completionTokens, totalTokens } }),
        }));

        resolve();
      });
    });
  } catch (error) {
    console.error("❌ Error fetching streaming response from Perplexity:", error);
    throw error;
  }
};

// Main Lambda Handler
export const handler = async (event) => {
  console.log("Perplexity Handler Event:", JSON.stringify(event, null, 2));

  const { connectionId, sessionId, message } = event;
  if (!connectionId || !sessionId) {
    return {
      statusCode: 400,
      body: "Invalid request: Missing connectionId or sessionId",
    };
  }

  try {
    console.log(`Sending message to Perplexity: ${message}`);
    const messages = [{ role: "user", content: message }];

    // ✅ Fetch Perplexity Streaming Response
    await fetchPerplexityResponse(messages, connectionId, sessionId);

    // ✅ Send "done" signal after full response
    await apiGateway.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ done: true }),
    }));

    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Streaming response sent to client" };
  } catch (error) {
    console.error("Perplexity API Error:", error);
    return {
      statusCode: 500,
      body: "Error streaming response from Perplexity",
    };
  }
};
