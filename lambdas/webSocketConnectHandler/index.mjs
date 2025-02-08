import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { randomUUID } from "crypto";
import { validate as isUUID } from "uuid";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";


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
const CONVERSATIONS_TABLE_NAME = getEnv("CONVERSATIONS_TABLE_NAME");
const WEBSOCKET_CONNECTIONS_TABLE_NAME = getEnv("WEBSOCKET_CONNECTIONS_TABLE_NAME");
const COGNITO_USER_POOL_ID = getEnv("COGNITO_USER_POOL_ID");
const WEBSOCKET_ENDPOINT = getEnv("WEBSOCKET_ENDPOINT");

// ✅ Initialize AWS DynamoDB Client
const dynamoDB = new DynamoDBClient({ region: AWS_REGION });

// ✅ Initialize AWS API Gateway Management API Client
const apiGateway = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });

// ✅ JWKS Client
const JWKS_URI = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`;
const client = jwksClient({ jwksUri: JWKS_URI });

// ✅ Fetch JWKS Signing Key
const getSigningKey = (header, callback) => {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error("Error fetching signing key:", err);
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
};

// ✅ Token Verification
const verifyToken = async (token) => {
  try {
    console.log("🔹 Verifying JWT...");
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, getSigningKey, { algorithms: ["RS256"] }, (err, decoded) =>
        err ? reject(err) : resolve(decoded)
      );
    });

    console.log("✅ Token successfully verified for user:", decoded.sub);
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
          TableName: CONVERSATIONS_TABLE_NAME,
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


// ✅ Check if the user owns the conversation
const userOwnsConversation = async (userId, conversationId) => {
  try {
    if (!isUUID(conversationId)) {
      console.error(`❌ Invalid conversationId format: ${conversationId}`);
      return false;
    }

    const { Item } = await dynamoDB.send(
      new GetCommand({
        TableName: CONVERSATIONS_TABLE_NAME,
        Key: { conversationId: conversationId },
      })
    );

    return Item && Item.userId === userId;
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

    console.log(`🔹 Writing to DynamoDB: ${JSON.stringify(params)}`);
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
    // const { connectionId } = event.requestContext;
    //console.log("✅ Connection ID:", connectionId);

    const params = event.queryStringParameters || {};
    const token = params.token;
    const sessionId = params.sessionId; // ✅ Ensure sessionId is received
    let conversationId = params.conversationId;

    if (!token || !sessionId) {
      console.error("❌ Missing token or sessionId");
      return { statusCode: 401, body: "Unauthorized: Missing token or sessionId" };
    }

    // ✅ Verify Token
    const decodedToken = await verifyToken(token);
    const userId = decodedToken.sub;
    const ttl = Math.floor(Date.now() / 1000) + 3600;

    // ✅ Validate & Verify Conversation ID (if provided)
    if (conversationId) {
      if (!isValidConversationId(conversationId)) {
        console.error("❌ Invalid conversationId format:", conversationId);
        return { statusCode: 400, body: "Invalid conversationId format." };
      }

      const ownsConversation = await userOwnsConversation(userId, conversationId);
      if (!ownsConversation) {
        console.error(`❌ Unauthorized access attempt by User: ${userId}`);
        return { statusCode: 403, body: "Forbidden: Unauthorized conversation access." };
      }
    } else {
      // ✅ Generate new conversationId & store in Conversations Table
      conversationId = await generateUniqueConversationId();
      if (!conversationId) {
        console.error("❌ Failed to generate conversation ID");
        return { statusCode: 500, body: "Internal Server Error: Failed to create conversation" };
      }

      console.log(`✅ New Conversation ID: ${conversationId}`);

      await putItem(
        CONVERSATIONS_TABLE_NAME,
        {
          conversationId: conversationId,
          userId: userId,
          title: "New Conversation",
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
          deleteAt: ttl + 2592000,
        },
        "attribute_not_exists(conversationId)"
      );
    }

    // ✅ Store WebSocket connection
    await dynamoDB.send(
      new PutCommand({
        TableName: WEBSOCKET_CONNECTIONS_TABLE_NAME,
        Item: {
          sessionId, // ✅ Ensure sessionId is included
          connectionId: connectionId,
          conversationId: conversationId,
          userId: userId,
          deleteAt: ttl,
        },
      })

    );

    await apiGateway.send(new PostToConnectionCommand({
      ConnectionId: connectionId, // ✅ Correct placement
      Data: JSON.stringify({ conversationId: conversationId }) // ✅ Send only conversationId inside Data
    }));
    
    return { statusCode: 200, body: "Connected" };
  } catch (error) {
    console.error("❌ Lambda Execution Error:", error);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
