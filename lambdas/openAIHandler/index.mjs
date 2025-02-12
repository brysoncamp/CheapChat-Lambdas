import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import OpenAI from "openai";
import { encoding_for_model } from "tiktoken";

// Initialize AWS Clients
const secretsManager = new SecretsManagerClient({});
const apiGateway = new ApiGatewayManagementApiClient({
  endpoint: process.env.WEBSOCKET_ENDPOINT,
});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE_NAME;

// Fetch OpenAI API Key (cached)
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

// Accurate token counting for completion tokens
const countTokens = (text, model = "gpt-4o") => {
  const encoder = encoding_for_model(model);
  const tokenCount = encoder.encode(text).length + 1;
  encoder.free();
  return tokenCount;
};

// Accurate token counting for input tokens
const countTokensForMessages = (messages, model = "gpt-4o") => {
  const encoder = encoding_for_model(model);

  let tokenCount = 2;

  messages.forEach(({ role, content }) => {
    tokenCount += 4;
    tokenCount += encoder.encode(role).length;
    tokenCount += encoder.encode(content).length;
  });

  return tokenCount;
};


export const handler = async (event) => {
  console.log("🟢 OpenAI Handler Event:", JSON.stringify(event, null, 2));

  // "sonar-pro"
  const { action, connectionId, sessionId, message, conversationId } = event;
  if (!action || !connectionId || !sessionId || !message || !conversationId) {
    return {
      statusCode: 400,
      body: "Invalid request: Missing parameters",
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
      model: action,
      messages: messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    console.log(`🔹 Streaming OpenAI response back to WebSocket client: ${connectionId}`);
    console.log(`🟢 OpenAI Model Used: ${response.model}`);


    let promptTokens = 0;
    let completionTokens = 0;
    let receivedUsage = false;
    let fullResponse = "";

    // ✅ Process OpenAI Streaming
    for await (const chunk of response) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
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

      // console.log("Open AI Chunk:", chunk); // ✅ Log the chunk for debugging

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

    // Token estimates
    if (!receivedUsage) {
      promptTokens = countTokensForMessages(messages);
      completionTokens = countTokens(fullResponse);
    }

    console.log("--- calculating cost ---");

    const modelCosts = {
      "gpt-4o": { "input": 5, "output": 20 }, // 5 µ$ per token input, 20 µ$ per token output
      "gpt-4o-mini": { "input": 0.15, "output": 0.6 },
      "o1-mini": { "input": 2.2, "output": 8.8 },
      "o3-mini": { "input": 2.2, "output": 8.8 },
      "chatgpt-4o-latest": { "input": 10, "output": 30 },
      "gpt-4-turbo": { "input": 20, "output": 60 },
      "gpt-4": { "input": 60, "output": 120 },
      "gpt-3.5-turbo": { "input": 1, "output": 3 }
    };
    
    const priceData = modelCosts[action];
    
    if (!priceData) {
      console.error(`❌ Unknown model: ${action}`);
      throw new Error(`Unknown model: ${action}`);
    }
    
    // Convert token counts to BigInt to avoid precision issues
    const promptCostMicroDollars = BigInt(Math.round(promptTokens * priceData.input * 1e6));  // µ$
    const completionCostMicroDollars = BigInt(Math.round(completionTokens * priceData.output * 1e6)); // µ$
    
    const totalCostMicroDollars = promptCostMicroDollars + completionCostMicroDollars;
    
    // Convert from µ$ to dollars at the end
    const finalCostDollars = Number(totalCostMicroDollars) / 1e6;
    console.log("Final Cost (USD):", finalCostDollars);

    console.log("--- saving message to dynamo db ---");

    // Determine messageindex 
    const { Item } = await dynamoDB.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "conversationId = :conversationId",
      ExpressionAttributeValues: {
        ":conversationId": conversationId
      },
      ScanIndexForward: false, // Get the latest message first
      Limit: 1
    }));

    const messageIndex = (Item?.messageIndex ?? -1) + 1;

    console.log("Conversation ID:", conversationId);
    console.log("Message Index:", messageIndex);

    const messageItem = {
      conversationId,
      messageIndex,
      query: message,
      response: fullResponse,
      model: action,
      promptTokens,
      completionTokens,
      cost: finalCostDollars
    };

    console.log("Message Item:", messageItem);
    
    await dynamoDB.send(new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: messageItem,
    }));

    console.log(`🟢 Token Usage: Prompt = ${promptTokens}, Completion = ${completionTokens}, Total = ${totalTokens}`);


    // sned this data to messages table (dynamo db)
    // The messages table jas a conversationId partition key and messageIndex sort key 
    // We should track the user's query, response, model used, the prompt tokens, completion tokens, cost


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
