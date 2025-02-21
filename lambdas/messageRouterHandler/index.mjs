import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { sendMessage } from "/opt/nodejs/apiGateway.mjs";
import { generateName } from "/opt/nodejs/openAINamer.mjs";

import { randomUUID } from "crypto";

const lambda = new LambdaClient({});
const dynamoDB = new DynamoDBClient({});
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE_NAME;
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE_NAME;

const putItem = async (table, item, condition = null) => {
  try {
    const params = { TableName: table, Item: item };
    if (condition) params.ConditionExpression = condition;

    console.log(`🔹 Writing to DynamoDB: ${JSON.stringify(params)}`);
    await dynamoDB.send(new PutCommand(params));
  } catch (error) {
    console.error(`❌ Failed to put item into ${table}: ${error.message}`);
    throw new Error("Database insert failed");
  }
};

const nameConversation = async (message, conversationId, connectionId, userId) => {
  try {
    // ✅ Generate conversation name
    const { name, cost } = await generateName(message);
    console.log("✅ Name generated:", name);
    console.log("💰 Cost:", cost);

    // ✅ Attempt to update DynamoDB
    try {
      /*await dynamoDB.send(new UpdateCommand({
        TableName: CONVERSATIONS_TABLE,
        Key: { conversationId }, // Ensure "conversationId" is the primary key
        UpdateExpression: "SET title = :title",
        ExpressionAttributeValues: {
          ":title": name
        }
      }));*/
      const ttl = Math.floor(Date.now() / 1000) + 3600;

      await putItem(
        CONVERSATIONS_TABLE,
        {
          conversationId: conversationId,
          userId: userId,
          title: name,
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
          deleteAt: ttl + 2592000,
        },
        "attribute_not_exists(conversationId)"
      );
      console.log(`✅ Title updated for conversationId: ${conversationId}`);
    } catch (dbError) {
      console.error(`❌ Failed to update title in DynamoDB for ${conversationId}:`, dbError);
    }

    // ✅ Attempt to send message even if the DB update failed
    try {
      await sendMessage(connectionId, { title: name });
      console.log(`✅ Title sent to client for connectionId: ${connectionId}`);
    } catch (wsError) {
      console.error(`❌ Failed to send title to WebSocket for ${connectionId}:`, wsError);
    }

  } catch (nameError) {
    console.error("❌ Error generating name:", nameError);
  }
};


const generateUniqueConversationId = async () => {
  let conversationId;
  let exists = true;
  let attempts = 0;
  const MAX_ATTEMPTS = 5;

  while (exists && attempts < MAX_ATTEMPTS) {
    conversationId = randomUUID();
    attempts++;
    try {
      const { Item } = await dynamoDB.send(
        new GetCommand({
          TableName: CONVERSATIONS_TABLE,
          Key: { conversationId: conversationId },
        })
      );
      exists = !!Item;
    } catch (error) {
      console.warn(`⚠️ DynamoDB lookup failed (attempt ${attempts}): ${error.message}`);
      exists = false;
    }
  }

  return exists ? randomUUID() : conversationId;
};



export const handler = async (event) => {
  console.log("🟢 WebSocket Message Event:", JSON.stringify(event, null, 2));

  const { sessionId, action, message, conversationId: eventConversationId } = event;

  if (!sessionId || !action) {
    console.error("❌ Missing sessionId or action");
    return { statusCode: 400, body: "Invalid request: Missing sessionId or action" };
  }

  let connectionId;
  let conversationId = eventConversationId;

  let backgroundTasks = [];

  // ✅ 2. Handle CANCEL request BEFORE ANYTHING ELSE
  if (action === "cancel") {
    console.log(`🚫 Cancel request received for session: ${sessionId}`);

    await dynamoDB.send(
      new UpdateCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { sessionId },
        UpdateExpression: "SET canceled = :canceled",
        ExpressionAttributeValues: { ":canceled": true },
      })
    );

    return { statusCode: 200, body: "Processing canceled" };
  }


  try {
    const result = await dynamoDB.send(
      new GetCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { sessionId },
      })
    );

    if (!result.Item) {
      console.error("❌ No active connection found for sessionId:", sessionId);
      return { statusCode: 404, body: "No active WebSocket connection found" };
    }

    connectionId = result.Item.connectionId;
    if (!conversationId) {

      // generate conversation id
      conversationId = await generateUniqueConversationId();
      if (!conversationId) {
        console.error("❌ Failed to generate conversation ID");
        return { statusCode: 500, body: "Internal Server Error: Failed to create conversation" };
      }
      
      
      //conversationId = result.Item.conversationId;
      console.log("FIRST MESSGE IN CONVERSATION - GENERATE NAME", conversationId);
      backgroundTasks.push(nameConversation(message, conversationId, connectionId, result.Item.userId));
    }
    
    console.log(`✅ Retrieved connectionId: ${connectionId} for sessionId: ${sessionId}`);

    await sendMessage(connectionId, { conversationId });

  } catch (error) {
    console.error("❌ Error fetching connectionId from DynamoDB:", error);
    return { statusCode: 500, body: "Failed to retrieve WebSocket connection" };
  }

  
  // ✅ 3. Route messages to OpenAI Lambda
  const lambdaFunctionMap = { 
    "gpt-4o": "openAIHandler",
    "gpt-4o-mini": "openAIHandler",
    "o1": "openAIHandler",
    "o1-mini": "openAIHandler",
    "o3-mini": "openAIHandler",
    "chatgpt-4o-latest": "openAIHandler",
    "gpt-4-turbo": "openAIHandler",
    "gpt-4": "openAIHandler",
    "gpt-3.5-turbo": "openAIHandler",
    "sonar-reasoning-pro": "perplexityHandler",
    "sonar-reasoning": "perplexityHandler",
    "sonar-pro": "perplexityHandler",
    "sonar": "perplexityHandler"
  };

  const functionName = lambdaFunctionMap[action];

  if (!functionName) {
    console.error(`❌ Unknown action: ${action}`);
    return { statusCode: 400, body: `Unsupported action: ${action}` };
  }

  try {
    console.log(`🔹 Forwarding message to ${functionName}...`);
    const payload = { action, connectionId, message, sessionId, conversationId };

    backgroundTasks.push(
      lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      )
    );

    await Promise.allSettled(backgroundTasks);

    console.log(`✅ Message forwarded to ${functionName}`);
    return { statusCode: 200, body: `Message forwarded to ${functionName}` };
  } catch (error) {
    console.error("❌ Error routing message:", error);
    return { statusCode: 500, body: "Failed to process message" };
  }
};