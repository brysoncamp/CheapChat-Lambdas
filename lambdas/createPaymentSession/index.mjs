import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

let stripe;

export const handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));

    const allowedOrigins = ["http://localhost:3000", "https://cheap.chat"];
    const requestOrigin = event.headers?.origin || ""; 
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "https://cheap.chat"; 

    try {
        const command = new GetSecretValueCommand({ SecretId: "StripeSecrets" });
        const secretData = await secretsClient.send(command);
        const secretString = secretData.SecretString;
        const parsedSecret = JSON.parse(secretString);
        const STRIPE_SECRET_KEY = parsedSecret.STRIPE_SECRET_KEY || secretString; // Adjust if your secret is plain text

        if (!stripe) {
            stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        }

        const { amount, userId } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        console.log(`Creating Stripe session for ${amount} USD (User: ${userId})...`);
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