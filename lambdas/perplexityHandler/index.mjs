import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import fetch from "node-fetch";

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

// Function to handle Perplexity API Request
const fetchPerplexityResponse = async (messages, connectionId, sessionId) => {
  const apiKey = await getPerplexityKey();
  console.log("🔹 Fetching streaming response from Perplexity...");

  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
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

    console.log(`🔹 API Response Status: ${response.status}`);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ Perplexity API error: ${response.statusText} - ${errorBody}`);
      throw new Error(`Perplexity API error: ${response.statusText}`);
    }

    console.log("✅ Streaming response from Perplexity...");

    // ✅ Read streaming response in chunks
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let receivedUsage = false;
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

    // ✅ Process the streaming response
    while (true) {
      const { done, value } = await reader.read();
      if (done || timeoutTriggered || isCanceled) break;

      const chunk = decoder.decode(value, { stream: true });
      console.log("🔹 Received chunk:", chunk);

      try {
        const chunkData = JSON.parse(chunk);

        // ✅ Extract token usage if available
        if (chunkData.usage) {
          promptTokens = chunkData.usage.prompt_tokens;
          completionTokens = chunkData.usage.completion_tokens;
          totalTokens = chunkData.usage.total_tokens;
          receivedUsage = true;
        }

        // ✅ Extract text response
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

    // ✅ Cleanup
    clearTimeout(timeout);

    // ✅ If request wasn't canceled, send "done"
    if (!timeoutTriggered && !isCanceled) {
      await apiGateway.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ done: true }),
      }));
    }

    return {
      fullResponse,
      promptTokens,
      completionTokens,
      totalTokens,
      receivedUsage,
    };
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
    const { fullResponse, promptTokens, completionTokens, totalTokens, receivedUsage } =
      await fetchPerplexityResponse(messages, connectionId, sessionId);

    clearTimeout(timeout);

    // ✅ Estimate Token Usage
    const promptTokensEstimate = estimateTokens(message);
    const completionTokensEstimate = estimateTokens(fullResponse);

    console.log(`🟢 Token Usage (Estimated): Prompt = ${promptTokensEstimate}, Completion = ${completionTokensEstimate}`);
    if (receivedUsage) {
      console.log(`🟢 Token Usage (Actual): Prompt = ${promptTokens}, Completion = ${completionTokens}, Total = ${totalTokens}`);
    }

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
