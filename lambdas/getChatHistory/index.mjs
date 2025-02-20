import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const dynamoDB = new DynamoDBClient({});
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE_NAME;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE_NAME;

export const handler = async (event) => {
    console.log("🟢 Chat History Event:", JSON.stringify(event, null, 2));

    // ✅ Handle CORS
    const allowedOrigins = ["http://localhost:3000", "https://cheap.chat"];
    const requestOrigin = event.headers?.origin || ""; 
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "https://cheap.chat";

    // ✅ Extract `conversationId` from GET request query parameters
    const conversationId = event.queryStringParameters?.conversationId;

    if (!conversationId) {
        console.error("❌ Missing conversationId query parameter");
        return {
            statusCode: 400,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ error: "Missing conversationId query parameter" })
        };
    }

    // ✅ Extract User ID from API Gateway Authorizer (NO manual JWT verification)
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

    // ✅ Step 1: Check if the conversation belongs to the user
    const { Item: conversation } = await dynamoDB.send(new GetCommand({
        TableName: CONVERSATIONS_TABLE,
        Key: { conversationId }
    }));

    if (!conversation || conversation.userId !== userId) {
        return {
            statusCode: 403,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ error: "Forbidden: You do not have access to this conversation" })
        };
    }

    console.log("✅ Conversation found and user authorized");

    // ✅ Step 2: Retrieve messages from the conversation
    const { Items: messages } = await dynamoDB.send(new QueryCommand({
        TableName: MESSAGES_TABLE,
        KeyConditionExpression: "conversationId = :conversationId",
        ExpressionAttributeValues: {
            ":conversationId": conversationId
        },
        ScanIndexForward: true // Retrieves messages in chronological order
    }));

    console.log(`✅ Retrieved ${messages.length} messages`);

    // ✅ Return messages to the client
    // ✅ Return messages and conversation title to the client
    return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": allowOrigin },
        body: JSON.stringify({ 
            title: conversation.title,
            messages 
        })
    };

};
