import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

let stripe;

export const handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));

    // ✅ Handle OPTIONS preflight request for CORS
    if (event.requestContext.http.method === "OPTIONS") {
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "http://localhost:3000, https://cheap.chat",
                "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "86400" // Cache for 24 hours
            },
            body: ""
        };
    }

    try {
        // ✅ Fetch Stripe Secret Key from AWS Secrets Manager
        const command = new GetSecretValueCommand({
            SecretId: "StripeSecrets" // Change this to match your secret name in AWS
        });

        const secretData = await secretsClient.send(command);
        const secretString = secretData.SecretString;

        // ✅ Parse secret value (Handles JSON format)
        const parsedSecret = JSON.parse(secretString);
        const STRIPE_SECRET_KEY = parsedSecret.STRIPE_SECRET_KEY || secretString; // Adjust if your secret is plain text

        if (!stripe) {
            stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        }

        // ✅ Parse request body
        const { amount, userId } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        // ✅ Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            currency: "usd",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: { name: "CheapChat Credits" },
                        unit_amount: amountInCents
                    },
                    quantity: 1
                }
            ],
            success_url: `https://cheap.chat/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://cheap.chat/cancel`,
            metadata: { userId }
        });

        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "http://localhost:3000, https://cheap.chat",
                "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "86400"
            },
            body: JSON.stringify({ id: session.id })
        };
    } catch (error) {
        console.error("Error processing payment:", error);

        return {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Origin": "http://localhost:3000, https://cheap.chat",
                "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Max-Age": "86400"
            },
            body: JSON.stringify({ error: error.message })
        };
    }
};
