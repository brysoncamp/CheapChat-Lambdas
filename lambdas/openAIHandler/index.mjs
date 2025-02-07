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
    const data = await secretsManager
      .getSecretValue({ SecretId: "OpenAISecrets" })
      .promise();
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
    const timeoutMs = 25000; // 25 seconds

    // ✅ Start a separate timeout that marks the request as timed out
    const timeout = setTimeout(async () => {
      console.log(`⚠️ Timeout reached for connection ${connectionId}`);
      timeoutTriggered = true;
    }, timeoutMs);

    // ✅ Separate Cancellation Check Loop (runs every second)
    const checkCancellation = async () => {
      while (!isCanceled && !timeoutTriggered) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Check every 1s

        const checkResult = await dynamoDB
          .get({
            TableName: CONNECTIONS_TABLE,
            Key: { sessionId },
          })
          .promise();

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
      stream_options: { include_usage: true },
    });

    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let receivedUsage = false;

    // ✅ Process OpenAI Streaming
    for await (const chunk of response) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
        receivedUsage = true;
      }

      // If either the timeout or a cancel is triggered, break out.
      if (timeoutTriggered || isCanceled) {
        console.log(`🛑 Stopping streaming for session ${sessionId}`);

        if (isCanceled) {
          await apiGateway
            .postToConnection({
              ConnectionId: connectionId,
              Data: JSON.stringify({ canceled: true }),
            })
            .promise();

          await dynamoDB.update({
            TableName: CONNECTIONS_TABLE,
            Key: { sessionId },
            UpdateExpression: "REMOVE canceled", // Removes the canceled flag
          }).promise();
        }

        if (timeoutTriggered) {
          await apiGateway
            .postToConnection({
              ConnectionId: connectionId,
              Data: JSON.stringify({ timeout: true }),
            })
            .promise();
        }

        if (!receivedUsage) {
          console.log("⚠️ Waiting for OpenAI to send token usage before closing...");
          continue; // ✅ Keep listening for final `chunk.usage`
        }

        break;
      }

      const text = chunk.choices?.[0]?.delta?.content || "";
      if (text) {
        await apiGateway
          .postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ text }),
          })
          .promise();
      }
    }

    // ✅ Clear timeout if OpenAI finished before 25s
    clearTimeout(timeout);

    console.log(`🟢 Token Usage: Prompt = ${promptTokens}, Completion = ${completionTokens}, Total = ${totalTokens}`);

    // ✅ If request wasn't canceled, send "done"
    if (!timeoutTriggered && !isCanceled) {
      await apiGateway
        .postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify({ done: true }),
        })
        .promise();
    }

    console.log("✅ Response sent successfully");
    return { statusCode: 200, body: "Response sent to client" };
  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    // We can no longer rely on AbortError detection
    return {
      statusCode: 500,
      body: "Error contacting OpenAI or reading the stream",
    };
  }
};
