import AWS from 'aws-sdk';
import Stripe from 'stripe';

const ssm = new AWS.SSM();

let stripe;

export const handler = async (event) => {
    try {
        // Fetch Stripe Secret Key
        const secretData = await ssm.getParameter({
            Name: "/stripe/secret_key",
            WithDecryption: true
        }).promise();

        const STRIPE_SECRET_KEY = secretData.Parameter.Value;

        if (!stripe) {
            stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
        }

        const { amount, userId } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            currency: 'usd',
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'CheapChat Credits' },
                    unit_amount: amountInCents,
                },
                quantity: 1,
            }],
            success_url: `https://cheap.chat/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://cheap.chat/cancel`,
            metadata: { userId },
        });

        return { statusCode: 200, body: JSON.stringify({ id: session.id }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
