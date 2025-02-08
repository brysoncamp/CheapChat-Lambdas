import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";  // ✅ FIXED: Import full module
const { verify } = jwt;          // ✅ FIXED: Destructure `verify`
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

export const handler = async (event) => {
  console.log("🟢 WebSocket Connection Event:", JSON.stringify(event, null, 2));

  try {
    const { connectionId } = event.requestContext;
    console.log("✅ Connection ID:", connectionId);  // LOG 1

    const params = event.queryStringParameters || {};
    console.log("✅ Query Params:", params);  // LOG 2

    const token = params.token;
    let conversationId = params.conversationId;
    console.log("✅ Token received:", token ? "Yes" : "No");  // LOG 3

    if (!token) {
      console.error("❌ Missing token");
      return { statusCode: 401, body: "Unauthorized: Missing token" };
    }

    // ✅ Verify Token
    console.log("🔹 Verifying Token...");
    const decodedToken = await verifyToken(token);
    console.log("✅ Decoded Token:", decodedToken);  // LOG 4

    const userId = decodedToken.sub;
    const ttl = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
    console.log("✅ User ID:", userId, "TTL:", ttl);  // LOG 5

    // ✅ Validate and Verify Conversation ID (if provided)
    if (conversationId) {
      console.log("🔹 Validating provided conversationId:", conversationId);  // LOG 6

      if (!isValidConversationId(conversationId)) {
        console.error("❌ Invalid conversationId format:", conversationId);
        return { statusCode: 400, body: "Invalid conversationId format." };
      }

      console.log("🔹 Checking conversation ownership...");
      const ownsConversation = await userOwnsConversation(userId, conversationId);
      console.log("✅ Conversation Ownership:", ownsConversation);  // LOG 7

      if (!ownsConversation) {
        console.error(`❌ Unauthorized access attempt by User: ${userId}`);
        return { statusCode: 403, body: "Forbidden: Unauthorized conversation access." };
      }
    } else {
      console.log("🔹 Generating a new conversationId...");
      conversationId = await generateUniqueConversationId();
      console.log("✅ New Conversation ID:", conversationId);  // LOG 8

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
        "attribute_not_exists(ConversationID)" 
      );
    }

    console.log("🔹 Storing WebSocket connection in DynamoDB...");
    await putItem(DYNAMO_DB_TABLE_NAME, {
      ConnectionID: connectionId,
      ConversationID: conversationId,
      UserID: userId,
      DeleteAt: ttl,
    });

    console.log("✅ Connection stored. Returning success response.");  // LOG 9

    return { statusCode: 200, body: JSON.stringify({ message: "Connected", conversationId }) };
  } catch (error) {
    console.error("❌ Lambda Execution Error:", error);  // LOG 10
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
