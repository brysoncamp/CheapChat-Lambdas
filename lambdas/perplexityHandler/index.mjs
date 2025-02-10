import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import https from 'https';

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

// Track sequence numbers per session
const sessionSequenceMap = new Map();  // Stores the last sequence number per session

const fetchPerplexityResponse = async (messages, connectionId, sessionId) => {
    const apiKey = await getPerplexityKey();
    const postData = JSON.stringify({
      model: "sonar",
      messages: messages,
      stream: true,
    });

    const options = {
      hostname: 'api.perplexity.ai',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let buffer = '';
        let sequence = 0;

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          let boundary = buffer.lastIndexOf('\n');
          if (boundary !== -1) {
            let completeMessages = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 1);
            completeMessages.split('\n').forEach(message => {
              if (message.trim()) {
                sequence++;  // Increment sequence for each message
                processMessage(message, connectionId, sessionId, sequence);
              }
            });
          }
        });

        res.on('end', () => {
          if (buffer.trim().length > 0) {
            sequence++;
            processMessage(buffer, connectionId, sessionId, sequence);
          }
          resolve();
        });
      });

      req.on('error', (e) => {
        console.error(`Problem with request: ${e.message}`);
        reject(e);
      });

      req.write(postData);
      req.end();
    });
};

const processMessage = async (message, connectionId, sessionId, sequence) => {
    console.log(`Processing message [Session: ${sessionId}, Seq: ${sequence}]:`, message);
    try {
        const cleanMessage = message.replace(/^data: /, '').trim();
        if (cleanMessage) {
            const data = JSON.parse(cleanMessage);
            console.log('Data processed:', data);

            if (!sessionMessageQueues.has(sessionId)) {
                sessionMessageQueues.set(sessionId, []);
            }

            const queue = sessionMessageQueues.get(sessionId);
            queue.push({ sequence, data });

            queue.sort((a, b) => a.sequence - b.sequence); // Ensure the queue remains ordered

            while (queue.length > 0) {
                const { sequence, data } = queue.shift(); // Get the next message in order

                if (data.choices && data.choices.length > 0) {
                    const deltaContent = data.choices[0].delta.content;
                    if (deltaContent) {
                        await apiGateway.send(new PostToConnectionCommand({
                            ConnectionId: connectionId,
                            Data: JSON.stringify({ text: deltaContent, seq: sequence, sessionId }),
                        }));
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
};

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
    await apiGateway.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ done: true }),
    }));

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
