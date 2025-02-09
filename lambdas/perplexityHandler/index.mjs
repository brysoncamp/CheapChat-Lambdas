import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { request } from "undici"; // ✅ Using undici for streaming

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

// Function to handle Perplexity API Request (Using `undici`)
const fetchPerplexityResponse = async (messages, connectionId, sessionId) => {
  const apiKey = await getPerplexityKey();
  console.log("🔹 Fetching streaming response from Perplexity...");

  try {
    const { body } = await request("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: messages,
        stream: true, // ✅ Enable streaming
      }),
    });

    console.log("✅ Processing streaming response...");

    const reader = body.pipeThrough(new TextDecoderStream()).getReader();

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

    while (true) {
      const { done, value } = await reader.read();
      if (done || timeoutTriggered || isCanceled) break;

      try {
        const chunkData = JSON.parse(value);

        // ✅ Extract token usage if available
        if (chunkData.usage) {
          console.log("🔹 Token usage:", chunkData.usage);
        }

        // ✅ Extract text response and send it
        const text = chunkData.choices?.[0]?.delta?.content || "";
        if (text) {
          await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({ text }),
          }));
          fullResponse += text;
        }
      } catch (error) {
        console.error("⚠️ Error parsing chunk:", error);
      }
    }

    console.log("✅ Finished streaming response.");
    clearTimeout(timeout);

    return { fullResponse };
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
