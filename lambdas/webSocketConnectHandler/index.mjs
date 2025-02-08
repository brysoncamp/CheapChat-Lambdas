import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";  // ✅ FIXED: Import full module
const { verify } = jwt;          // ✅ FIXED: Destructure `verify`
import jwksClient from "jwks-rsa";
import { randomUUID } from "crypto";
import { validate as isUUID } from "uuid";

// ✅ Fetch environment variables safely
const getEnv = (key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    throw new Error(`Missing environment variable: ${key}`);
  }
  return process.env[key];
};

// ✅ Store environment variables once to avoid redundant calls
const AWS_REGION = getEnv("AWS_REGION");
const CONVERSATIONS_TABLE_NAME = getEnv("CONVERSATIONS_TABLE_NAME");
const WEBSOCKET_CONNECTIONS_TABLE_NAME = getEnv("WEBSOCKET_CONNECTIONS_TABLE_NAME");

// ✅ Initialize AWS DynamoDB Client
const dynamoDB = new DynamoDBClient({ region: AWS_REGION });

// ✅ JWKS Client
const JWKS_URI = `https://cognito-idp.${getEnv("AWS_REGION")}.amazonaws.com/${getEnv(
  "COGNITO_USER_POOL_ID"
)}/.well-known/jwks.json`;
const client = jwksClient({ jwksUri: JWKS_URI });

// ✅ Fetch JWKS Signing Key
const getSigningKey = async (header) => {
  try {
    const key = await client.getSigningKey(header.kid);
    return key.getPublicKey();
  } catch (err) {
    console.error("❌ Error fetching signing key:", err);
    throw err;
  }
};

// ✅ Token Verification
const verifyToken = async (token) => {
  try {
    const decoded = await new Promise((resolve, reject) => {
      verify(token, getSigningKey, { algorithms: ["RS256"] }, (err, decoded) =>
        err ? reject(err) : resolve(decoded)
      );
    });

    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("Unauthorized: Token expired.");
    }

    return decoded;
  } catch (error) {
    console.error("❌ Token verification failed:", error.message);
    throw new Error("Unauthorized: Token verification failed.");
  }
};

// ✅ Ensure the provided conversationId is valid
const isValidConversationId = (id) => isUUID(id);

// ✅ Ensure Unique `conversationId` (Checks Conversations Table)
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
          TableName: CONVERSATIONS_TABLE_NAME,  // ✅ Ensures unique ID in the right table
          Key: { ConversationID: conversationId },
        })
      );
      exists = !!Item;
    } catch (error) {
      exists = false;
    }
  }

  if (exists) {
    return randomUUID();
  }

  return conversationId;
};

// ✅ Check if the user owns the conversation (Search in Conversations Table)
const userOwnsConversation = async (userId, conversationId) => {
  try {
    if (!isUUID(conversationId)) return false;

    const { Item } = await dynamoDB.send(
      new GetCommand({
        TableName: CONVERSATIONS_TABLE_NAME,
        Key: { ConversationID: conversationId },
      })
    );

    return Item && Item.UserID === userId;
  } catch (error) {
    return false;
  }
};

// ✅ Insert Item into DynamoDB with Error Handling
const putItem = async (table, item, condition = null) => {
  try {
    const params = { TableName: table, Item: item };
    if (condition) params.ConditionExpression = condition;

    await dynamoDB.send(new PutCommand(params));
  } catch (error) {
    console.error(`❌ Failed to put item into ${table}: ${error.message}`);
    throw new Error("Database insert failed");
  }
};

// ✅ WebSocket Connect Handler
export const handler = async (event) => {
  console.log("🟢 WebSocket Connection Event:", JSON.stringify(event, null, 2));

  try {
    const { connectionId } = event.requestContext;
    console.log("✅ Connection ID:", connectionId);

    const params = event.queryStringParameters || {};
    const token = params.token;
    let conversationId = params.conversationId;

    if (!token) {
      return { statusCode: 401, body: "Unauthorized: Missing token" };
    }

    // ✅ Verify Token
    const decodedToken = await verifyToken(token);
    const userId = decodedToken.sub;
    const ttl = Math.floor(Date.now() / 1000) + 3600;

    // ✅ Validate & Verify Conversation ID (if provided)
    if (conversationId) {
      if (!isValidConversationId(conversationId)) {
        return { statusCode: 400, body: "Invalid conversationId format." };
      }

      const ownsConversation = await userOwnsConversation(userId, conversationId);
      if (!ownsConversation) {
        return { statusCode: 403, body: "Forbidden: Unauthorized conversation access." };
      }
    } else {
      // ✅ If no conversationId, generate a new one and store in Conversations Table
      conversationId = await generateUniqueConversationId();

      await putItem(
        CONVERSATIONS_TABLE_NAME,  // ✅ Store conversation details
        {
          ConversationID: conversationId,
          UserID: userId,
          Title: "New Conversation",
          CreatedAt: Date.now(),
          LastMessageAt: Date.now(),
          TTL: ttl + 2592000, // 30-day expiration
        },
        "attribute_not_exists(ConversationID)"
      );
    }

    // ✅ Store WebSocket connection in WebSocketConnections Table
    await putItem(WEBSOCKET_CONNECTIONS_TABLE_NAME, {
      ConnectionID: connectionId,
      ConversationID: conversationId,
      UserID: userId,
      DeleteAt: ttl,
    });

    return { statusCode: 200, body: JSON.stringify({ message: "Connected", conversationId }) };
  } catch (error) {
    console.error("❌ Lambda Execution Error:", error);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
