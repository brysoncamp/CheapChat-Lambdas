import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const secretsClient = new SecretsManagerClient({ region: "us-east-1" });

let stripe;

export const handler = async (event) => {
    try {
        // Fetch Stripe Secret Key from Secrets Manager
        const command = new GetSecretValueCommand({
            SecretId: "StripeSecrets-RhCaMe" // Change this to match your secret name in AWS
        });

        const secretData = await secretsClient.send(command);
        const secretString = secretData.SecretString;

        // Parse secret value (Handles JSON format)
        const parsedSecret = JSON.parse(secretString);
        const STRIPE_SECRET_KEY = parsedSecret.STRIPE_SECRET_KEY || secretString; // Adjust if your secret is plain text

        if (!stripe) {
            stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        }

        // Parse request body
        const { amount, userId } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        // Create Stripe Checkout Session
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

        return { statusCode: 200, body: JSON.stringify({ id: session.id }) };
    } catch (error) {
        console.error("Error processing payment:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};