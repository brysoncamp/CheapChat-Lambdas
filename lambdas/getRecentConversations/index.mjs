import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const dynamoDB = new DynamoDBClient({});
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE_NAME;

export const handler = async (event) => {
    console.log("🟢 Get Recent Chats Event:", JSON.stringify(event, null, 2));

    const allowedOrigins = ["http://localhost:3000", "https://cheap.chat"];
    const requestOrigin = event.headers?.origin || ""; 
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "https://cheap.chat";

    // Fetch pagination keys from query parameters
    const conversationId = event.queryStringParameters?.conversationId;
    const lastMessageAt = parseInt(event.queryStringParameters?.lastMessageAt, 10);

    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) {
        console.error("❌ Unable to extract user ID from token");
        return {
            statusCode: 401,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ error: "Unauthorized: Unable to extract user ID from token" })
        };
    }
    console.log("✅ Authenticated User ID:", userId);

    try {
        const queryParams = {
            TableName: CONVERSATIONS_TABLE,
            IndexName: "UserConversationsIndex", // GSI name
            KeyConditionExpression: "userId = :userId",
            ExpressionAttributeValues: {
                ":userId": userId
            },
            ScanIndexForward: false, // Sort in descending order
            Limit: 50  // Retrieve up to 50 conversations
        };

        // Use ExclusiveStartKey for pagination if a starting point is provided
        if (conversationId && !isNaN(lastMessageAt)) {
            queryParams.ExclusiveStartKey = {
                userId,
                conversationId, // Use conversationId instead of index
                lastMessageAt
            };
        }

        const { Items: conversations, LastEvaluatedKey } = await dynamoDB.send(new QueryCommand(queryParams));

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ 
                conversations,
                lastEvaluatedKey: LastEvaluatedKey // Return this so the client can use it for the next request
            })
        };
    } catch (error) {
        console.error("❌ Error querying conversations:", error);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ error: "Failed to query conversations" })
        };
    }
};