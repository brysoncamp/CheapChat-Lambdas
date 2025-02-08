import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const REGION = process.env.AWS_REGION;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const JWKS_URI = `https://cognito-idp.${REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`;

const client = jwksClient({ jwksUri: JWKS_URI });

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const dynamoDB = DynamoDBDocumentClient.from(dynamoDBClient);

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error("Error fetching signing key:", err);
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

export async function handler(event) {
  console.log("🟢 WebSocket Connection Event:", JSON.stringify(event, null, 2));

  const { connectionId } = event.requestContext;
  const params = event.queryStringParameters || {};
  const token = params.token;
  const sessionId = params.sessionId; // ✅ Client must send a sessionId

  if (!token || !sessionId) {
    console.error("❌ Missing token or sessionId");
    return { statusCode: 401, body: "Unauthorized: Missing token or sessionId" };
  }

  try {
    // ✅ Verify Cognito Token
    const decodedToken = await new Promise((resolve, reject) => {
      jwt.verify(token, getSigningKey, { algorithms: ["RS256"] }, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });

    console.log("✅ Decoded Token:", decodedToken);

    const userId = decodedToken.sub;
    const ttl = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL

    // ✅ Store Connection with sessionId in DynamoDB
    await dynamoDB.send(
      new PutCommand({
        TableName: process.env.WEBSOCKET_CONNECTIONS_TABLE_NAME,
        Item: { sessionId, connectionId, userId, deleteAt: ttl },
      })
    );

    console.log(`✅ Stored connection: ${connectionId} for user: ${userId} with sessionId: ${sessionId}`);

    return { statusCode: 200, body: "Connected" };
  } catch (error) {
    console.error("❌ Token validation failed:", error);
    return { statusCode: 401, body: "Unauthorized: Invalid token" };
  }
}
