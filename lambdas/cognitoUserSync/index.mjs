import AWS from "aws-sdk";

const dynamoDB = new AWS.DynamoDB.DocumentClient();

export const handler = async (event) => {
    console.log("Cognito PostConfirmation Trigger:", JSON.stringify(event, null, 2));

    // ✅ Extract user data from Cognito event
    const userId = event.request.userAttributes.sub; // Cognito unique ID
    const email = event.request.userAttributes.email || "unknown";
    const createdAt = new Date().toISOString();

    // ✅ Insert into DynamoDB
    const params = {
        TableName: "Users",
        Item: {
            userId,           // Unique Cognito ID
            email,            // Email from Cognito
            currentCredits: 0, // Default credits
            disputedCredits: 0,
            totalSpent: 0,
            createdAt
        }
    };

    try {
        await dynamoDB.put(params).promise();
        console.log(`✅ User ${userId} added to Users table.`);
        return event;
    } catch (error) {
        console.error("🚨 DynamoDB Insert Error:", error);
        throw new Error("Error inserting user into database");
    }
};