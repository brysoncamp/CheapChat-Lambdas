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
  
        res.on('end', async () => {
          // Check if there's any remaining data in the buffer to process as potentially the last data
          if (buffer.trim().length > 0) {
            processMessage(buffer, connectionId);
          } else {
            // If no data is left, but the stream has ended, assume the last processed message was the final one
            console.log('Stream ended without final data. Assume last processed message was final.');
          }

          await new Promise(resolve => setTimeout(resolve, 50));
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
// Helper function to process each message
// Helper function to process each message



let messageQueue = {}; // Stores the latest message for each connectionId
let citationQueue = {}; // Stores citations for each connectionId (only once)
let sendTimers = {}; // Keeps track of timeouts for each connectionId
let sentCitations = {}; // Track whether citations have been sent for a connection

const processMessage = async (message, connectionId) => {
    console.log('Processing message:', message);
    
    try {
        const cleanMessage = message.replace(/^data: /, '').trim();
        if (cleanMessage) {
            const data = JSON.parse(cleanMessage);
            console.log('Data processed:', data);

            if (data.choices && data.choices.length > 0) {
                const deltaContent = data.choices[0].message.content;
                console.log('Delta Content:', deltaContent);

                const finished = data.choices[0]?.finish_reason === "stop";
                const citations = data.citations || [];

                // Store citations **only if they haven’t been sent before**
                if (citations.length > 0 && !sentCitations[connectionId]) {
                    citationQueue[connectionId] = citations;
                    sentCitations[connectionId] = true; // Prevent duplicate sending
                }

                if (deltaContent) {
                    // Store the latest message in the queue
                    messageQueue[connectionId] = deltaContent;
                }

                // If a timer does not exist, start one
                if (!sendTimers[connectionId]) {
                    sendTimers[connectionId] = setTimeout(async () => {
                        await sendLatestMessage(connectionId);
                    }, 50); // Small delay to batch updates
                }

                if (finished) {
                    console.log('Finished processing message:', message);

                    if (messageQueue[connectionId] || citationQueue[connectionId]) {
                        console.log(`Waiting for last message to send before "done" for ${connectionId}...`);
                        await sendLatestMessage(connectionId); // Ensure last queued message is sent
                    }

                    setTimeout(async () => {
                        await apiGateway.send(new PostToConnectionCommand({
                            ConnectionId: connectionId,
                            Data: JSON.stringify({ done: true }),
                        }));    
                        console.log("Done signal sent.");
                    }, 100);

                    // Cleanup connection's message queue and timer
                    delete messageQueue[connectionId];
                    delete citationQueue[connectionId];
                    delete sendTimers[connectionId];
                    delete sentCitations[connectionId]; // Reset citations for the next session
                }
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
};

// Function to send the latest queued message (including citations first)
const sendLatestMessage = async (connectionId) => {
    try {
        // Send citations **only if they exist and haven’t been sent yet**
        if (citationQueue[connectionId]) {
            await apiGateway.send(new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: JSON.stringify({ citations: citationQueue[connectionId] }),
            }));
            console.log(`Sent citations to ${connectionId}:`, citationQueue[connectionId]);
            delete citationQueue[connectionId]; // Ensure they are only sent once
        }

        // Send the latest message
        if (messageQueue[connectionId]) {
            await apiGateway.send(new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: JSON.stringify({ message: messageQueue[connectionId] }),
            }));
            console.log(`Sent message to ${connectionId}:`, messageQueue[connectionId]);
            delete messageQueue[connectionId];
        }

        delete sendTimers[connectionId]; // Cleanup timer reference
    } catch (error) {
        console.error(`Error sending message to ${connectionId}:`, error);
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