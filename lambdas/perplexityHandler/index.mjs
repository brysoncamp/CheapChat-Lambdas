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
const fetchPerplexityResponse = async (messages) => {
    const apiKey = await getPerplexityKey();
    
    console.log("🔹 Fetching response from Perplexity...");
    
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
          stream: false,
        }),
      });
  
      console.log(`🔹 API Response Status: ${response.status}`);
  
      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ Perplexity API error: ${response.statusText} - ${errorBody}`);
        throw new Error(`Perplexity API error: ${response.statusText}`);
      }
  
      console.log("✅ Successfully received response from Perplexity");
  
      const jsonResponse = await response.json();
      console.log("🔹 Perplexity Response JSON:", JSON.stringify(jsonResponse, null, 2));
  
      return jsonResponse;
    } catch (error) {
      console.error("❌ Error fetching response from Perplexity:", error);
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

    let isCanceled = false;
    let timeoutTriggered = false;
    const timeoutMs = 60000;

    // Timeout Mechanism
    const timeout = setTimeout(() => {
      console.log(`Timeout reached for connection ${connectionId}`);
      timeoutTriggered = true;
    }, timeoutMs);

    // Check for Cancellation
    const checkCancellation = async () => {
      while (!isCanceled && !timeoutTriggered) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        try {
          const checkResult = await dynamoDB.send(
            new GetCommand({
              TableName: CONNECTIONS_TABLE,
              Key: { sessionId },
            })
          );

          if (checkResult.Item?.canceled) {
            isCanceled = true;
          }
        } catch (err) {
          console.error(`Error checking session cancellation: ${err.message}`);
        }
      }
    };

    checkCancellation();

    // Prepare messages
    const messages = [{ role: "user", content: message }];

    // Fetch Perplexity Response
    const perplexityResponse = await fetchPerplexityResponse(messages);

    console.log(`Streaming Perplexity response back to WebSocket client: ${connectionId}`);

    const fullResponse = perplexityResponse.choices?.[0]?.message?.content || "";

    if (fullResponse) {
      await apiGateway.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text: fullResponse }),
        })
      );
    }

    clearTimeout(timeout);

    // If request wasn't canceled, send "done"
    if (!timeoutTriggered && !isCanceled) {
      await apiGateway.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ done: true }),
        })
      );
    }

    // Estimate Token Usage
    const promptTokensEstimate = estimateTokens(message);
    const completionTokensEstimate = estimateTokens(fullResponse);

    // Actual Token Usage from API Response
    const promptTokensActual = perplexityResponse.usage?.prompt_tokens || 0;
    const completionTokensActual = perplexityResponse.usage?.completion_tokens || 0;
    const totalTokensActual = perplexityResponse.usage?.total_tokens || 0;

    console.log(`Token Usage (Estimated): Prompt = ${promptTokensEstimate}, Completion = ${completionTokensEstimate}`);
    console.log(`Token Usage (Actual): Prompt = ${promptTokensActual}, Completion = ${completionTokensActual}, Total = ${totalTokensActual}`);

    console.log("Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };
  } catch (error) {
    console.error("Perplexity API Error:", error);
    return {
      statusCode: 500,
      body: "Error contacting Perplexity or processing the response",
    };
  }
};
