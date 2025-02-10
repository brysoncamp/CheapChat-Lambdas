import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import https from "https";

// Initialize AWS Clients
const secretsManager = new SecretsManagerClient({});
const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.DYNAMO_DB_TABLE_NAME;

// Track message queues per session
const messageQueueMap = new Map();

// Fetch Perplexity API Key (cached)
let cachedApiKey = null;
const getPerplexityKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  try {
    const data = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: "PerplexitySecrets" })
    );
    cachedApiKey = JSON.parse(data.SecretString).PERPLEXITY_API_KEY;
    return cachedApiKey;
  } catch (error) {
    console.error("Error retrieving API Key:", error);
    throw new Error("Failed to retrieve Perplexity API Key");
  }
};

// Queue handler to enforce sequential sending
const enqueueMessage = async (connectionId, sessionId, message) => {
  if (!messageQueueMap.has(sessionId)) {
    messageQueueMap.set(sessionId, Promise.resolve());
  }

  // Chain each message send to the previous one to enforce order
  messageQueueMap.set(
    sessionId,
    messageQueueMap.get(sessionId).then(async () => {
      try {
        await apiGateway.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(message),
          })
        );
      } catch (error) {
        console.error(`Error sending message for session ${sessionId}:`, error);
      }
    })
  );

  return messageQueueMap.get(sessionId);
};

// ✅ Fix: Store raw message chunks in a queue BEFORE assigning sequence numbers
const fetchPerplexityResponse = async (messages, connectionId, sessionId) => {
  const apiKey = await getPerplexityKey();
  const postData = JSON.stringify({
    model: "sonar",
    messages: messages,
    stream: true,
  });

  const options = {
    hostname: "api.perplexity.ai",
    path: "/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let buffer = "";
      let messageQueue = []; // Store raw messages before assigning sequence numbers

      res.on("data", async (chunk) => {
        buffer += chunk.toString();
        let boundary = buffer.lastIndexOf("\n");

        if (boundary !== -1) {
          let completeMessages = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);

          for (const message of completeMessages.split("\n")) {
            if (message.trim()) {
              messageQueue.push(message);
            }
          }

          // ✅ Process messages sequentially only after they are fully queued
          while (messageQueue.length > 0) {
            let rawMessage = messageQueue.shift();
            await processMessage(rawMessage, connectionId, sessionId);
          }
        }
      });

      res.on("end", async () => {
        if (buffer.trim().length > 0) {
          messageQueue.push(buffer);
        }

        while (messageQueue.length > 0) {
          let rawMessage = messageQueue.shift();
          await processMessage(rawMessage, connectionId, sessionId);
        }

        resolve();
      });
    });

    req.on("error", (e) => {
      console.error(`Problem with request: ${e.message}`);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
};

// ✅ Assign sequence numbers *only after* messages are correctly ordered
let sessionSequenceMap = new Map();

const processMessage = async (message, connectionId, sessionId) => {
  console.log(`Processing message [Session: ${sessionId}]:`, message);
  try {
    const cleanMessage = message.replace(/^data: /, "").trim();
    if (cleanMessage) {
      const data = JSON.parse(cleanMessage);
      console.log("Data processed:", data);

      if (!sessionSequenceMap.has(sessionId)) {
        sessionSequenceMap.set(sessionId, 0);
      }

      let sequence = sessionSequenceMap.get(sessionId) + 1;
      sessionSequenceMap.set(sessionId, sequence);

      if (data.choices && data.choices.length > 0) {
        const deltaContent = data.choices[0].delta?.content || "";
        if (deltaContent) {
          await enqueueMessage(connectionId, sessionId, {
            text: deltaContent,
            seq: sequence,
            sessionId,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error processing message:", error);
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

    // Fetch Perplexity Streaming Response
    await fetchPerplexityResponse(messages, connectionId, sessionId);

    // Send "done" signal after full response
    await enqueueMessage(connectionId, sessionId, { done: true });

    console.log("Response sent successfully");
    return { statusCode: 200, body: "Streaming response sent to client" };
  } catch (error) {
    console.error("Perplexity API Error:", error);
    return {
      statusCode: 500,
      body: "Error streaming response from Perplexity",
    };
  }
};
