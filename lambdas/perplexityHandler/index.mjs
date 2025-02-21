import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import https from "https";

import { getRecentMessages, getNextMessageIndex } from "/opt/nodejs/messagesHelper.mjs";
import { startTimeout, checkCancellation } from "/opt/nodejs/statusHelper.mjs";
import { sendMessage } from "/opt/nodejs/apiGateway.mjs";
import { putDynamoItem } from "/opt/nodejs/dynamoDB/putDynamo.mjs";

// Initialize AWS Clients
const secretsManager = new SecretsManagerClient({});
const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});
const dynamoDB = new DynamoDBClient({});

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE_NAME;

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

/* return new Promise((resolve, reject) => {
    try {
        const req = https.request(options, (res) => {
            let buffer = '';
            let latestResponse = { fullResponse: '', usage: undefined, citations: undefined };

            const processQueue = [];

            res.on('data', (chunk) => {
                buffer += chunk.toString();
                let boundary = buffer.lastIndexOf('\n');
                if (boundary !== -1) {
                    let completeMessages = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 1);

                    completeMessages.split('\n').forEach(message => {
                        if (message.trim()) {
                            processQueue.push(
                                processMessage(message, connectionId).then(processedData => {
                                    if (processedData?.fullResponse) {
                                        if (statusFlags.timeoutTriggered || statusFlags.isCanceled) {
                                            abortController.abort();
                                        } else {
                                            latestResponse = {
                                                fullResponse: processedData.fullResponse,
                                                usage: processedData.usage,
                                                citations: processedData.citations
                                            };
                                        }
                                    }
                                }).catch(error => {
                                    console.error('Error in processing message:', error);
                                })
                            );
                        }
                    });
                }
            });

            res.on('end', () => {
                Promise.all(processQueue).then(() => {
                    resolve({
                        fullResponse: latestResponse.fullResponse,
                        usage: latestResponse.usage,
                        citations: latestResponse.citations
                    });
                }).catch(error => {
                    console.error('Error in final message processing:', error);
                    reject(error);
                });
            });
        });

        req.on('error', (e) => {
            console.error(`Problem with request: ${e.message}`);
            reject(e);
        });

        req.write(postData);
        req.end();
    } catch (error) {
        console.error(`Error during HTTP request setup: ${error.message}`);
        reject(error);
    }
});
 */

const fetchPerplexityResponse = async (apiKey, action, messages, connectionId, statusFlags) => {
  try {
    const postData = JSON.stringify({
      model: action,
      messages: messages,
      stream: true,
    });

    const abortController = new AbortController();
    const { signal } = abortController;

    const options = {
      hostname: 'api.perplexity.ai',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: signal
    };

    return new Promise((resolve, reject) => {

      let latestResponse = { fullResponse: '', usage: null, citations: null };
      const processQueue = [];

      try {
        const req = https.request(options, (res) => {
          
          let buffer = '';

          res.on('data', (chunk) => {
            if (statusFlags.timeoutTriggered || statusFlags.isCanceled) {
              abortController.abort();
            }

            buffer += chunk.toString();
            let boundary = buffer.lastIndexOf('\n');
            if (boundary !== -1) {
              let completeMessages = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 1);

              completeMessages.split('\n').forEach(message => {
                if (message.trim()) {
                  processQueue.push(
                    processMessage(message, connectionId).then(processedData => {
                      if (processedData?.fullResponse) {
                        latestResponse = {
                          fullResponse: processedData.fullResponse,
                          usage: processedData.usage,
                          citations: processedData.citations
                        };
                      }
                    }).catch(error => {
                      console.error('Error in processing message:', error);
                    })
                  );
                }
              });
            }
          });

          res.on('end', () => {
            // Finalize processing on end for normal completion
            Promise.allSettled(processQueue).then(() => {
              resolve(latestResponse);
            });
          });
  
          res.on('close', () => {
            // Ensure final cleanup if close occurs unexpectedly
            Promise.allSettled(processQueue).then(() => {
              resolve(latestResponse);
            });
          });
        });

        req.on('error', () => {
          // Handle error and resolve with the latest data, regardless of error cause
          Promise.allSettled(processQueue).finally(() => {
            resolve(latestResponse);
          });
        });

        req.write(postData);
        req.end();
      } catch (error) {
        console.error(`Error during HTTP request setup: ${error.message}`);
        reject(error);
      }
    });
  } catch (error) {
    console.error(`Unexpected error in fetchPerplexityResponse: ${error.message}`);
    throw error;
  }
};



let messageQueue = {};
let citationQueue = {};
let sendTimers = {};
let sentCitations = {};

const processMessage = async (message, connectionId) => {
    console.log('Processing message:', message);
    
    try {
        const cleanMessage = message.replace(/^data: /, '').trim();
        if (cleanMessage) {
            const data = JSON.parse(cleanMessage);
            console.log('Data processed:', data);

            if (data.choices && data.choices.length > 0) {
                const messageContent = data.choices[0].message.content;
                console.log('Message Content:', messageContent);

                const finished = data.choices[0]?.finish_reason === "stop";
                const citations = data.citations || [];

                // Store citations **only if they haven’t been sent before**
                if (citations.length > 0 && !sentCitations[connectionId]) {
                    citationQueue[connectionId] = citations;
                    sentCitations[connectionId] = true; // Prevent duplicate sending
                }

                if (messageContent) {
                    // Store the latest message in the queue
                    messageQueue[connectionId] = messageContent;
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

                    /*
                    setTimeout(async () => {
                        await apiGateway.send(new PostToConnectionCommand({
                            ConnectionId: connectionId,
                            Data: JSON.stringify({ done: true }),
                        }));    
                        console.log("Done signal sent.");
                    }, 100);*/

                    // Cleanup connection's message queue and timer
                    delete messageQueue[connectionId];
                    delete citationQueue[connectionId];
                    delete sendTimers[connectionId];
                    delete sentCitations[connectionId]; // Reset citations for the next session

                    //const promptTokens = data.usage?.prompt_tokens || 0;
                    //const completionTokens = data.usage?.completion_tokens || 0;
                    //const usage = data.usage;
                    console.log("--------------------");
                    console.log("Sending data", messageContent, data.usage);
                    console.log("Message", message);

                    return { fullResponse: messageContent, usage: data.usage, citations: data?.citations };
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

const modelCosts = {
  "sonar-reasoning-pro": { "input": 0.000004, "output": 0.000016, "search": 0.01 },
  "sonar-reasoning": { "input": 0.000002, "output": 0.00001, "search": 0.01  },
  "sonar-pro": { "input": 0.000006, "output": 0.00003, "search": 0.01  },
  "sonar": { "input": 0.000002, "output": 0.0000006, "search": 0.01  },
  "r1-1776": { "input": 0.000004, "output": 0.000016 },
};

const calculateCost = (usage, model) => {
  const priceData = modelCosts[model];
  if (!priceData) throw new Error(`Unknown model: ${model}`);

  let inputTokens = usage.prompt_tokens || 0;
  if (usage.citation_tokens) inputTokens += usage.citation_tokens;

  const num_searches = usage.num_search_queries || (priceData.search ? 1 : 0);

  const unroundedCost = (inputTokens * priceData.input) + (usage.completion_tokens * priceData.output) + (num_searches * priceData.search);
  return Number(unroundedCost.toFixed(8));
};

// Main Lambda Handler
export const handler = async (event) => {
  console.log("Perplexity Handler Event:", JSON.stringify(event, null, 2));

  const { action, connectionId, sessionId, message, conversationId } = event;
  if (!connectionId || !sessionId) {
    return {
      statusCode: 400,
      body: "Invalid request: Missing connectionId or sessionId",
    };
  }

  try {
    console.log(`Sending message to Perplexity: ${message}`);
    const messages = await getRecentMessages(MESSAGES_TABLE, conversationId, message, 5);
    const apiKey = await getPerplexityKey();

    const statusFlags = { isCanceled: false, timeoutTriggered: false };
    const timeout = startTimeout(statusFlags, 60000);
    checkCancellation(CONNECTIONS_TABLE, sessionId, statusFlags);

    const { fullResponse, usage, citations } = await fetchPerplexityResponse(apiKey, action, messages, connectionId, statusFlags);
    console.log("Response from perplexity completed!");
    console.log("Full Response:", fullResponse);
    //console.log("Prompt Tokens:", promptTokens);
    //console.log("Completion Tokens:", completionTokens);

    clearTimeout(timeout);

    if (!statusFlags.timeoutTriggered && !statusFlags.isCanceled) {
      await sendMessage(connectionId, { done: true });
    }

    const cost = calculateCost(usage, action);
    console.log("Calculated Cost:", cost);

    const messageIndex = await getNextMessageIndex(MESSAGES_TABLE, conversationId);
    
    const messageItem = {
      conversationId,
      messageIndex,
      query: message,
      response: fullResponse,
      model: action,
      cost: cost
    };

    if (citations && citations.length > 0) {
      messageItem.citations = citations;
    }

    console.log("Message Item:", messageItem);
    
    await putDynamoItem(MESSAGES_TABLE, messageItem);


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