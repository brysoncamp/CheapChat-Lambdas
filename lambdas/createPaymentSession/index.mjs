import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";
import jwt from "jsonwebtoken"; // ✅ Import for decoding Cognito JWT

const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

let stripe;

export const handler = async (event) => {
    console.log("🔥 Received event:", JSON.stringify(event, null, 2));

    const allowedOrigins = ["http://localhost:3000", "https://cheap.chat"];
    const requestOrigin = event.headers?.origin || ""; 
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "https://cheap.chat"; 

    try {
        // ✅ Extract Authorization header
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return {
                statusCode: 401,
                headers: { "Access-Control-Allow-Origin": allowOrigin },
                body: JSON.stringify({ error: "Unauthorized: Missing or invalid token" })
            };
        }

        // ✅ Decode JWT to get user info
        const token = authHeader.split(" ")[1]; // Remove "Bearer" prefix
        const decoded = jwt.decode(token); // Decode without verification (trusted via API Gateway)
        const userEmail = decoded?.email || decoded?.["cognito:username"];

        if (!userEmail) {
            return {
                statusCode: 401,
                headers: { "Access-Control-Allow-Origin": allowOrigin },
                body: JSON.stringify({ error: "Unauthorized: Unable to extract email from token" })
            };
        }

        console.log("✅ User authenticated with email:", userEmail);

        // ✅ Fetch Stripe Secret Key from AWS Secrets Manager
        console.log("🔑 Fetching Stripe Secret Key...");
        const command = new GetSecretValueCommand({ SecretId: "StripeSecrets" });
        const secretData = await secretsClient.send(command);
        const secretString = secretData.SecretString;
        const parsedSecret = JSON.parse(secretString);
        const STRIPE_SECRET_KEY = parsedSecret.STRIPE_SECRET_KEY || secretString;

        if (!stripe) {
            stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        }

        // ✅ Parse request body
        const { amount } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        // ✅ Create Stripe Checkout Session
        console.log(`💳 Creating Stripe session for ${amount} USD (User: ${userEmail})...`);
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            currency: "usd",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: { 
                            name: "CheapChat Credits",
                            description: "Buy credits to send messages on CheapChat"
                        },
                        unit_amount: amountInCents
                    },
                    quantity: 1
                }
            ],
            success_url: `https://cheap.chat/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://cheap.chat/cancel`,
            metadata: { userEmail } // ✅ Store user email in Stripe metadata
        });

        console.log("✅ Stripe session created:", session.id);

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ id: session.id })
        };

    } catch (error) {
        console.error("🚨 Error processing payment:", error);

        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": allowOrigin },
            body: JSON.stringify({ error: error.message })
        };
    }
};
