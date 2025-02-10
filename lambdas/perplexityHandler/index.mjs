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
// Function to handle Perplexity API Request using native https module

let isFirstData = true; // Flag to track if the current data is the first one processed

// Function to handle Perplexity API Request using native https module
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

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let boundary = buffer.lastIndexOf('\n');
        if (boundary !== -1) {
          let completeMessages = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          completeMessages.split('\n').forEach(message => {
            if (message.trim()) processMessage(message, connectionId);
          });
        }
      });

      res.on('end', () => {
        if (buffer.trim().length > 0) {
          processMessage(buffer, connectionId); // Process any remaining data as last data
        }
        console.log('Stream ended');
        resolve();
      });
    });

    req.on('error', (e) => {
      console.error(`Problem with request: ${e.message}`);
      reject(e);
    });

    // Write data to request body
    req.write(postData);
    req.end();
  });
};

// Helper function to process each message
const processMessage = (message, connectionId) => {
  console.log('Processing message:', message);
  try {
    const cleanMessage = message.replace(/^data: /, '').trim();
    if (cleanMessage) {
      const data = JSON.parse(cleanMessage);
      console.log('Data processed:', data);

      if (data.choices && data.choices.length > 0) {
        const deltaContent = data.choices[0].delta;
        console.log('Delta Content:', deltaContent);
        apiGateway.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ delta: deltaContent }),
        }));
      }
    }
  } catch (error) {
    console.error('Error processing message:', error);
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
