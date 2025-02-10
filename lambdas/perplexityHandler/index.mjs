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
const fetchPerplexityResponse = async (messages, connectionId, sessionId) => {
    const apiKey = await getPerplexityKey();
    const postData = JSON.stringify({ model: "sonar", messages, stream: true });

    const options = {
        hostname: 'api.perplexity.ai',
        path: '/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let buffer = '';

            const processQueue = async () => {
                while (buffer.includes('\n')) {
                    const index = buffer.indexOf('\n');
                    const message = buffer.slice(0, index).trim();
                    buffer = buffer.slice(index + 1);
                    
                    if (message) {
                        try {
                            const data = JSON.parse(message.replace(/^data: /, ''));
                            if (data.choices && data.choices.length > 0) {
                                const deltaContent = data.choices[0].delta.content;
                                if (deltaContent) {
                                    await apiGateway.send(new PostToConnectionCommand({
                                        ConnectionId: connectionId,
                                        Data: JSON.stringify({ text: deltaContent }),
                                    }));
                                }
                            }
                        } catch (error) {
                            console.error("❌ JSON Parsing Error:", error);
                        }
                    }
                }
            };

            res.on('data', async (chunk) => {
                buffer += chunk.toString();
                await processQueue();
            });

            res.on('end', async () => {
                if (buffer.trim()) await processQueue();  // Process any remaining data
                resolve();
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
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
