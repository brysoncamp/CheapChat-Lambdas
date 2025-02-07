import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"; // ✅ Only the client from this package
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb"; // ✅ Get & Update Command from lib-dynamodb
import OpenAI from "openai";
import { encoding_for_model } from "tiktoken";

// ✅ Initialize AWS Clients
const secretsManager = new SecretsManagerClient({});
const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

// ✅ Fetch OpenAI API Key (cached)
let cachedApiKey = null;
const getOpenAIKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  try {
    const data = await secretsManager.send(new GetSecretValueCommand({ SecretId: "OpenAISecrets" }));
    cachedApiKey = JSON.parse(data.SecretString).OPENAI_API_KEY;
    return cachedApiKey;
  } catch (error) {
    console.error("❌ Error retrieving API Key:", error);
    throw new Error("Failed to retrieve OpenAI API Key");
  }
};

// ✅ Function to count tokens using OpenAI's official tokenizer
const countTokens = (text, model = "gpt-4o") => {
  const encoder = encoding_for_model(model);
  const tokenCount = encoder.encode(text).length;
  encoder.free();
  return tokenCount;
};

export const handler = async (event) => {
  console.log("🟢 OpenAI Handler Event:", JSON.stringify(event, null, 2));

  const { connectionId, sessionId, message } = event;
  if (!connectionId || !sessionId) {
    return {
      statusCode: 400,
      body: "Invalid request: Missing connectionId or sessionId",
    };
  }

  try {
    console.log(`🔹 Sending message to OpenAI: ${message}`);
    const apiKey = await getOpenAIKey();
    const openai = new OpenAI({ apiKey });

    let isCanceled = false;
    let timeoutTriggered = false;
    const timeoutMs = 60000;

    // ✅ Start a separate timeout that marks the request as timed out
    const timeout = setTimeout(async () => {
      console.log(`⚠️ Timeout reached for connection ${connectionId}`);
      timeoutTriggered = true;
    }, timeoutMs);

    // ✅ Separate Cancellation Check Loop
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

    // ✅ Start cancellation check in parallel
    checkCancellation();

    // ✅ Prepare messages for token estimation
    const messages = [{ role: "user", content: message }];

    // ✅ OpenAI Streaming Request
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let receivedUsage = false;
    let fullResponse = "";

    // ✅ Process OpenAI Streaming
    for await (const chunk of response) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
        receivedUsage = true;
      }

      if (timeoutTriggered || isCanceled) {
        console.log(`🛑 Stopping streaming for session ${sessionId}`);

        if (isCanceled) {
          await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({ canceled: true }),
          }));

          await dynamoDB.send(new UpdateCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { sessionId },
            UpdateExpression: "REMOVE canceled",
          }));
        }

        if (timeoutTriggered) {
          await apiGateway.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({ timeout: true }),
          }));
        }

        break;
      }

      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) {
        await apiGateway.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ text }),
        }));
        fullResponse += text;
      }
    }

    // ✅ Clear timeout if OpenAI finished before 60s
    clearTimeout(timeout);

    // ✅ If request wasn't canceled, send "done"
    if (!timeoutTriggered && !isCanceled) {
      await apiGateway.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ done: true }),
      }));
    }

    const promptTokensEstimate = countTokens(JSON.stringify(messages));
    const completionTokensEstimate = countTokens(fullResponse);

    console.log(`🟢 Token Usage: Prompt = ${promptTokens}, Completion = ${completionTokens}, Total = ${totalTokens}`);
    console.log(`🟢 Token Usage: Prompt Estimate = ${promptTokensEstimate}, Completion Estimate = ${completionTokensEstimate}`);


    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };
  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    return {
      statusCode: 500,
      body: "Error contacting OpenAI or reading the stream",
    };
  }
};
