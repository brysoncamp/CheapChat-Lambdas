import AWS from "aws-sdk";
import Stripe from "stripe";

const secretsClient = new AWS.SecretsManager({ region: "us-east-1" });
const dynamoDB = new AWS.DynamoDB.DocumentClient();

let stripe;
let stripeWebhookSecret;

/**
 * ✅ Fetch Stripe Secrets from AWS Secrets Manager
 */
async function fetchStripeSecrets() {
    if (stripe && stripeWebhookSecret) return;

    try {
        console.log("🔑 Fetching Stripe Secrets from AWS Secrets Manager...");
        const secretData = await secretsClient.getSecretValue({ SecretId: "StripeSecrets" }).promise();
        const parsedSecret = JSON.parse(secretData.SecretString);

        stripe = new Stripe(parsedSecret.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
        stripeWebhookSecret = parsedSecret.STRIPE_WEBHOOK_SECRET;

        console.log("✅ Stripe Secrets Loaded Successfully.");
    } catch (error) {
        console.error("🚨 Failed to load Stripe Secrets:", error);
        throw new Error("Error fetching Stripe secrets");
    }
}

/**
 * ✅ Stripe Webhook Handler
 */
export const handler = async (event) => {
    await fetchStripeSecrets();

    try {
        const sig = event.headers["stripe-signature"];
        let stripeEvent;

        try {
            stripeEvent = stripe.webhooks.constructEvent(event.body, sig, stripeWebhookSecret);
        } catch (err) {
            console.error("❌ Webhook signature verification failed:", err);
            return { statusCode: 400, body: "Webhook signature verification failed" };
        }

        console.log("🔹 Stripe Webhook Event:", JSON.stringify(stripeEvent, null, 2));

        switch (stripeEvent.type) {
            case "checkout.session.completed":
                await handleSuccessfulPayment(stripeEvent.data.object);
                break;
            case "charge.refunded":
                await handleRefund(stripeEvent.data.object);
                break;
            case "charge.dispute.created":
                await handleDispute(stripeEvent.data.object);
                break;
            case "charge.dispute.closed":
                await resolveDispute(stripeEvent.data.object);
                break;
            default:
                console.log(`ℹ️ Unhandled event type: ${stripeEvent.type}`);
                return { statusCode: 400, body: "Unhandled event type" };
        }

        return { statusCode: 200, body: "Webhook received" };
    } catch (error) {
        console.error("🚨 Webhook error:", error);
        return { statusCode: 500, body: "Internal server error" };
    }
};

async function handleSuccessfulPayment(session) {
    const userId = session.metadata?.userId;
    const credits = session.amount_total / 100;
    const transactionId = session.id;
    const paymentIntentId = session.payment_intent;
    const timestamp = new Date().toISOString();

    let chargeId = session.charge || null;
    let receiptUrl = null;

    // ✅ Fetch Charge ID if missing
    if (!chargeId && paymentIntentId) {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        chargeId = paymentIntent.latest_charge || null;
    }

    // ✅ Fetch Public Receipt URL if Charge ID exists
    if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId);
        receiptUrl = charge.receipt_url || null;
    }

    console.log(`✅ Payment received: User ID: ${userId}, Credits: ${credits}, Receipt: ${receiptUrl}`);

    // ✅ Store only `receiptUrl` in DynamoDB
    await dynamoDB.put({
        TableName: "CreditTransactions",
        Item: {
            transactionId,
            userId,
            type: "credit_added",
            amount: credits,
            timestamp,
            receiptUrl // ✅ Store only this
        }
    }).promise();
}


/**
 * ✅ Handle Refunds (Removes Credits)
 *
 * - Allows negative balance (user must "repay" before using credits again).
 */
async function handleRefund(refund) {
    const userId = refund.metadata?.userId;
    const refundAmount = refund.amount / 100;
    const transactionId = refund.id;
    const timestamp = new Date().toISOString();

    console.log(`⚠️ Refund issued: User ID: ${userId}, Amount: ${refundAmount} USD`);

    // ✅ Add refund to CreditTransactions
    await dynamoDB.put({
        TableName: "CreditTransactions",
        Item: {
            transactionId,
            userId,
            type: "charge_refunded",
            amount: -refundAmount,
            timestamp
        }
    }).promise();

    // ✅ Deduct credits from User's balance (allowing negative balance)
    await dynamoDB.update({
        TableName: "Users",
        Key: { userId },
        UpdateExpression: "SET currentCredits = currentCredits - :refundAmount",
        ExpressionAttributeValues: { ":refundAmount": refundAmount }
    }).promise();
}

/**
 * ✅ Handle Disputes (Freeze Credits)
 */
async function handleDispute(dispute) {
    const userId = dispute.metadata?.userId;
    const disputedAmount = dispute.amount / 100;
    const transactionId = dispute.id;
    const timestamp = new Date().toISOString();

    console.log(`🚨 Charge disputed: User ID: ${userId}, Amount: ${disputedAmount} USD`);

    // ✅ Add dispute to CreditTransactions
    await dynamoDB.put({
        TableName: "CreditTransactions",
        Item: {
            transactionId,
            userId,
            type: "dispute",
            amount: -disputedAmount,
            timestamp
        }
    }).promise();

    // ✅ Move disputed amount from current credits to disputed credits
    await dynamoDB.update({
        TableName: "Users",
        Key: { userId },
        UpdateExpression: "SET currentCredits = currentCredits - :amount, disputedCredits = disputedCredits + :amount",
        ExpressionAttributeValues: { ":amount": disputedAmount }
    }).promise();
}

/**
 * ✅ Handle Dispute Resolution (Fixing Multiple Dispute Issue)
 *
 * **If user WINS the dispute:**
 * - Stripe refunds them → We **permanently remove** that disputed amount.
 *
 * **If user LOSES the dispute:**
 * - They didn't get refunded → We **restore their credits**.
 */
async function resolveDispute(dispute) {
    const userId = dispute.metadata?.userId;
    const disputedAmount = dispute.amount / 100;
    const disputeWon = dispute.status === "won";
    const transactionId = dispute.id;
    const timestamp = new Date().toISOString();

    console.log(`⚖️ Dispute resolved: User ID: ${userId}, Won: ${disputeWon}`);

    if (disputeWon) {
        console.log(`✅ User ${userId} won the dispute. Removing disputed credits permanently.`);
        await dynamoDB.update({
            TableName: "Users",
            Key: { userId },
            UpdateExpression: "SET disputedCredits = disputedCredits - :amount",
            ExpressionAttributeValues: { ":amount": disputedAmount }    
        }).promise();
    } else {
        console.log(`❌ User ${userId} lost the dispute. Restoring credits.`);
        await dynamoDB.update({
            TableName: "Users",
            Key: { userId },
            UpdateExpression: "SET disputedCredits = disputedCredits - :amount, currentCredits = currentCredits + :amount",
            ExpressionAttributeValues: { ":amount": disputedAmount }
        }).promise();
    }

    // ✅ Add dispute resolution to CreditTransactions
    await dynamoDB.put({
        TableName: "CreditTransactions",
        Item: {
            transactionId,
            userId,
            type: "dispute_closed",
            amount: disputeWon ? -disputedAmount : disputedAmount, // Remove if won, restore if lost
            timestamp
        }
    }).promise();
}