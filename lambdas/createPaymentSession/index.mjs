import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

let stripe;

export const handler = async (event) => {
    console.log("🔥 Received event:", JSON.stringify(event, null, 2));

    // ✅ Handle OPTIONS preflight request for CORS
    if (event.requestContext.http.method === "OPTIONS") {
        console.log("✅ Handling OPTIONS request...");
        const response = {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "http://localhost:3000, https://cheap.chat",
                "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "86400" // Cache for 24 hours
            },
            body: JSON.stringify({ message: "CORS Preflight successful" }) // Ensure a JSON response
        };
        console.log("✅ Returning response:", JSON.stringify(response));
        return response;
    }

    console.log("❌ OPTIONS request was NOT detected. Proceeding to main logic...");
    
    try {
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Not an OPTIONS request" })
        };
    } catch (error) {
        console.error("🚨 Error in Lambda execution:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
