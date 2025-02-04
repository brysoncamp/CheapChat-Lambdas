import AWS from "aws-sdk";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const dynamoDB = new AWS.DynamoDB.DocumentClient();

// Use environment variables for non-sensitive values
const REGION = process.env.AWS_REGION;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const JWKS_URI = `https://cognito-idp.${REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`;

const client = jwksClient({ jwksUri: JWKS_URI });

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
  console.log("WebSocket Connection Event:", event);

  const { connectionId } = event.requestContext;
  const params = event.queryStringParameters || {};
  const token = params.token;

  if (!token) {
    console.error("No token provided");
    return { statusCode: 401, body: "Unauthorized: No token provided" };
  }

  try {
    // ✅ Verify Cognito Token using JWKS
    const decodedToken = await new Promise((resolve, reject) => {
      jwt.verify(token, getSigningKey, { algorithms: ["RS256"] }, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });

    console.log("Decoded Token:", decodedToken);

    const userId = decodedToken.sub;
    const ttl = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL

    // ✅ Store Connection in DynamoDB
    await dynamoDB.put({
      TableName: process.env.DYNAMO_DB_TABLE_NAME,
      Item: { connectionId, userId, deleteAt: ttl }
    }).promise();

    console.log(`Stored connection: ${connectionId} for user: ${userId}`);

    return { statusCode: 200, body: "Connected" };
  } catch (error) {
    console.error("Token validation failed:", error);
    return { statusCode: 401, body: "Unauthorized: Invalid token" };
  }
}
