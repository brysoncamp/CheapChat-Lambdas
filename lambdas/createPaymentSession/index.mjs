import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

let stripe;

export const handler = async (event) => {
    console.log("🔥 Received event:", JSON.stringify(event, null, 2));

    // ✅ List of allowed frontend origins
    const allowedOrigins = ["http://localhost:3000", "https://cheap.chat"];
    const requestOrigin = event.headers?.origin || ""; // Get the request’s origin safely
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "https://cheap.chat"; // Default to production domain

    // ✅ Handle OPTIONS preflight request for CORS
    if (event.requestContext.http.method === "OPTIONS") {
        console.log("✅ Handling OPTIONS request...");
        const response = {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": allowOrigin,
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
        // ✅ Fetch Stripe Secret Key from Secrets Manager
        console.log("🔑 Fetching Stripe Secret Key...");
        const command = new GetSecretValueCommand({ SecretId: "StripeSecrets" });
        const secretData = await secretsClient.send(command);
        const secretString = secretData.SecretString;
        const parsedSecret = JSON.parse(secretString);
        const STRIPE_SECRET_KEY = parsedSecret.STRIPE_SECRET_KEY || secretString; // Adjust if your secret is plain text

        if (!stripe) {
            stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        }

        // ✅ Parse request body
        const { amount, userId } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        // ✅ Create Stripe Checkout Session
        console.log(`💳 Creating Stripe session for ${amount} USD (User: ${userId})...`);
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card", "apple_pay", "google_pay"],
            mode: "payment",
            currency: "usd",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: { 
                            name: "CheapChat Credits",
                            description: "Buy credits to send messages on CheapChat",
                            images: ["https://e7.pngegg.com/pngimages/546/340/png-clipart-livechat-online-chat-logo-computer-icons-live-chat-miscellaneous-face-thumbnail.png"]
                        },
                        unit_amount: amountInCents
                    },
                    quantity: 1
                }
            ],
            success_url: `https://cheap.chat/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://cheap.chat/cancel`,
            metadata: { userId }
        });

        console.log("✅ Stripe session created:", session.id);

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": allowOrigin }, // ✅ Ensure all responses include CORS headers
            body: JSON.stringify({ id: session.id })
        };

    } catch (error) {
        console.error("🚨 Error processing payment:", error);

        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": allowOrigin }, // ✅ Ensure errors also include CORS headers
            body: JSON.stringify({ error: error.message })
        };
    }
};
