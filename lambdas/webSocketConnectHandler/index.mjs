import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { verify } from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { randomUUID } from "crypto";
import { validate as isUUID } from "uuid";

// ✅ Initialize AWS DynamoDB Client
const dynamoDB = new DynamoDBClient({ region: process.env.AWS_REGION });

// ✅ Environment Variable Helper
const getEnv = (key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    throw new Error(`Missing environment variable: ${key}`);
  }
  return process.env[key];
};

// ✅ Store environment variables once to avoid redundant calls
const DYNAMO_DB_TABLE_NAME = getEnv("DYNAMO_DB_TABLE_NAME");

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

// ✅ Token Verification with Expiration Check
const verifyToken = async (token) => {
  try {
    const decoded = await new Promise((resolve, reject) => {
      verify(token, getSigningKey, { algorithms: ["RS256"] }, (err, decoded) =>
        err ? reject(err) : resolve(decoded)
      );
    });

    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      console.error("❌ Expired token detected:", decoded.sub);
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

// ✅ Ensure Unique `conversationId`
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
          TableName: DYNAMO_DB_TABLE_NAME,
          Key: { ConversationID: conversationId },
        })
      );
      exists = !!Item;
    } catch (error) {
      console.error(`❌ DynamoDB lookup failed (attempt ${attempts}): ${error.message}`);
      exists = false;
    }
  }

  if (exists) {
    console.warn("⚠️ Max UUID attempts reached. Returning a random UUID without checking.");
    return randomUUID();
  }

  return conversationId;
};

// ✅ Check if the user owns the conversation
const userOwnsConversation = async (userId, conversationId) => {
  try {
    if (!isUUID(conversationId)) {
      console.error(`❌ Invalid conversationId format detected: ${conversationId}`);
      return false;
    }

    const { Item } = await dynamoDB.send(
      new GetCommand({
        TableName: DYNAMO_DB_TABLE_NAME,
        Key: { ConversationID: conversationId },
      })
    );

    return Item && Item.UserID === userId;
  } catch (error) {
    console.error(`❌ Error checking conversation ownership: ${error.message}`);
    return false;
  }
};

// ✅ Insert Item into DynamoDB with Error Handling
const putItem = async (table, item, condition = null) => {
  try {
    const params = { TableName: table, Item: item };
    if (condition) params.ConditionExpression = condition;

    if (!isUUID(item.ConversationID) || !item.UserID) {
      throw new Error(`❌ Invalid data format detected: ${JSON.stringify(item)}`);
    }

    await dynamoDB.send(new PutCommand(params));
  } catch (error) {
    console.error(`❌ Failed to put item into ${table}: ${error.message}`);
    throw new Error("Database insert failed");
  }
};

// ✅ WebSocket Connect Handler
export const handler = async (event) => {
  console.log("🟢 WebSocket Connection Event:", JSON.stringify(event, null, 2));

  const { connectionId } = event.requestContext;
  const params = event.queryStringParameters || {};
  const token = params.token;
  let conversationId = params.conversationId;

  if (!token) {
    console.error("❌ Missing token");
    return { statusCode: 401, body: "Unauthorized: Missing token" };
  }

  try {
    // ✅ Verify Token
    const decodedToken = await verifyToken(token);
    console.log("✅ Decoded Token:", decodedToken);

    const userId = decodedToken.sub;
    const ttl = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL

    // ✅ Validate and Verify Conversation ID (if provided)
    if (conversationId) {
      if (!isValidConversationId(conversationId)) {
        console.error("❌ Invalid conversationId format detected:", conversationId);
        return { statusCode: 400, body: "Invalid conversationId format." };
      }

      const ownsConversation = await userOwnsConversation(userId, conversationId);
      if (!ownsConversation) {
        console.error(
          `❌ Unauthorized access attempt by User: ${userId}, IP: ${event.requestContext.identity.sourceIp}, Origin: ${event.headers?.origin || "unknown"} to Conversation: ${conversationId}`
        );
        return { statusCode: 403, body: "Forbidden: Unauthorized conversation access." };
      }
    } else {
      // ✅ If no conversationId, generate a unique one
      conversationId = await generateUniqueConversationId();
      console.log(`🆕 Generated unique Conversation ID: ${conversationId}`);

      await putItem(
        DYNAMO_DB_TABLE_NAME,
        {
          ConversationID: conversationId,
          UserID: userId,
          Title: "New Conversation",
          CreatedAt: Date.now(),
          LastMessageAt: Date.now(),
          TTL: ttl + 2592000, // 30-day expiration
        },
        "attribute_not_exists(ConversationID)" // ✅ Prevents overwriting existing conversations
      );
    }

    // ✅ Store WebSocket connection
    await putItem(DYNAMO_DB_TABLE_NAME, {
      ConnectionID: connectionId,
      ConversationID: conversationId,
      UserID: userId,
      DeleteAt: ttl,
    });

    return { statusCode: 200, body: JSON.stringify({ message: "Connected", conversationId }) };
  } catch (error) {
    console.error("❌ Token validation failed:", error);
    return { statusCode: 401, body: "Unauthorized: Invalid token" };
  }
};