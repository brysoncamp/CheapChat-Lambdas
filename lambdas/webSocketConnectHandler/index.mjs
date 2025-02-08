import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";
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

// ✅ Store environment variables
const AWS_REGION = getEnv("AWS_REGION");
const COGNITO_USER_POOL_ID = getEnv("COGNITO_USER_POOL_ID");
const CONVERSATIONS_TABLE_NAME = getEnv("CONVERSATIONS_TABLE_NAME");
const WEBSOCKET_CONNECTIONS_TABLE_NAME = getEnv("WEBSOCKET_CONNECTIONS_TABLE_NAME");

// ✅ Initialize AWS DynamoDB Client
const dynamoDB = new DynamoDBClient({ region: AWS_REGION });

// ✅ JWKS Client
const JWKS_URI = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`;
const client = jwksClient({ jwksUri: JWKS_URI });

// ✅ Fetch JWKS Signing Key (Restored to Previous Working Method)
function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error("❌ Error fetching signing key:", err);
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// ✅ Verify Cognito JWT Token
const verifyToken = async (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getSigningKey, { algorithms: ["RS256"] }, (err, decoded) => {
      if (err) {
        console.error("❌ JWT Verification Failed:", err.message);
        reject(new Error("Unauthorized: Token verification failed."));
      } else {
        console.log("✅ JWT Verified Successfully!", decoded);
        resolve(decoded);
      }
    });
  });
};

// ✅ Ensure the provided conversationId is valid
const isValidConversationId = (id) => isUUID(id);

// ✅ Generate Unique `conversationId` (Checks Conversations Table)
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
          TableName: CONVERSATIONS_TABLE_NAME,
          Key: { ConversationID: conversationId },
        })
      );
      exists = !!Item;
    } catch (error) {
      exists = false;
    }
  }

  return exists ? randomUUID() : conversationId;
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
    const sessionId = params.sessionId; // ✅ Client must send a sessionId
    let conversationId = params.conversationId;

    if (!token || !sessionId) {
      console.error("❌ Missing token or sessionId");
      return { statusCode: 401, body: "Unauthorized: Missing token or sessionId" };
    }

    console.log("🔹 Verifying Token...");
    const decodedToken = await verifyToken(token);
    const userId = decodedToken.sub;
    console.log(`✅ Token verified for user: ${userId}`);

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
        CONVERSATIONS_TABLE_NAME, // ✅ Store conversation details
        {
          ConversationID: conversationId,
          UserID: userId,
          Title: "New Conversation",
          CreatedAt: Date.now(),
          LastMessageAt: Date.now(),
          TTL: Math.floor(Date.now() / 1000) + 2592000, // 30-day expiration
        },
        "attribute_not_exists(ConversationID)"
      );
    }

    // ✅ Store WebSocket connection in WebSocketConnections Table
    await putItem(WEBSOCKET_CONNECTIONS_TABLE_NAME, {
      ConnectionID: connectionId,
      SessionID: sessionId,
      ConversationID: conversationId,
      UserID: userId,
      DeleteAt: Math.floor(Date.now() / 1000) + 3600,
    });

    return { statusCode: 200, body: JSON.stringify({ message: "Connected", conversationId }) };
  } catch (error) {
    console.error("❌ Lambda Execution Error:", error);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
