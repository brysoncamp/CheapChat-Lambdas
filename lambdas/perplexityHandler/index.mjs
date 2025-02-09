import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import axios from "axios"; // ✅ Single dependency for HTTP + streaming

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

// Function to estimate token count
const estimateTokens = (text) => {
  return Math.ceil(text.split(/\s+/).length * 1.3); // Rough estimation
};

// ✅ Function to handle Perplexity API Request (Using axios)
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
      responseType: "stream", // ✅ Ensures proper stream handling
    });

    console.log("✅ Processing streaming response...");

    let fullResponse = "";
    let isCanceled = false;
    let timeoutTriggered = false;

    // ✅ Start checking for cancellation
    const checkCancellation = async () => {
      while (!isCanceled && !timeoutTriggered) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const checkResult = await dynamoDB.send(new GetCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { sessionId },
          }));
          if (checkResult.Item?.canceled) {
            isCanceled = true;
          }
        } catch (err) {
          console.error(`❌ Error checking session cancellation: ${err.message}`);
        }
      }
    };
    checkCancellation();

    // ✅ Start a timeout to prevent infinite waits
    const timeout = setTimeout(() => {
      console.log(`⚠️ Timeout reached for connection ${connectionId}`);
      timeoutTriggered = true;
    }, 60000);

    // ✅ Process Streamed Data (Fixes JSON Parsing Issue)
    response.data.on("data", async (chunk) => {
        if (timeoutTriggered || isCanceled) return;
      
        try {
          const chunkString = chunk.toString();
          console.log("🔹 RAW CHUNK RECEIVED:", chunkString); // ✅ Debug log to see EXACTLY what is received
      
          // Check if the chunk follows SSE format (Starts with "data:")
          const jsonMatch = chunkString.match(/^data:\s*(\{.*\})/);
          if (!jsonMatch) {
            console.warn("⚠️ Skipping invalid chunk:", chunkString); // Log anything that doesn't match
            return;
          }
      
          const jsonData = JSON.parse(jsonMatch[1]); // ✅ Now safely parse JSON
          console.log("🔹 Parsed JSON Data:", JSON.stringify(jsonData, null, 2)); // ✅ Log structured JSON data
      
          // ✅ Extract and send text response
          const text = jsonData.choices?.[0]?.delta?.content || "";
          if (text) {
            await apiGateway.send(new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: JSON.stringify({ text }),
            }));
            fullResponse += text;
          }
        } catch (error) {
          console.error("⚠️ Error parsing SSE chunk:", error);
        }
      });
      

    return new Promise((resolve) => {
      response.data.on("end", () => {
        clearTimeout(timeout);
        console.log("✅ Finished streaming response.");
        resolve({ fullResponse });
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

    // ✅ Prepare messages
    const messages = [{ role: "user", content: message }];

    // ✅ Fetch Perplexity Streaming Response
    const { fullResponse } = await fetchPerplexityResponse(messages, connectionId, sessionId);

    // ✅ Send "done" signal after full response
    await apiGateway.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ done: true }),
    }));

    // ✅ Estimate Token Usage
    const promptTokensEstimate = estimateTokens(message);
    const completionTokensEstimate = estimateTokens(fullResponse);

    console.log(`🟢 Token Usage (Estimated): Prompt = ${promptTokensEstimate}, Completion = ${completionTokensEstimate}`);

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
