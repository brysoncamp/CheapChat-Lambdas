export const handler = async (event) => {
    try {
        console.log("Received event:", JSON.stringify(event, null, 2));

        // ✅ Handle preflight OPTIONS request
        if (event.httpMethod === "OPTIONS") {
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "https://cheap.chat, http://localhost:3000",
                    "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                },
                body: ""
            };
        }

        // ✅ Parse the request body
        const { amount, userId } = JSON.parse(event.body);
        const amountInCents = Math.round(amount * 100);

        // ✅ Create Stripe Checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            currency: "usd",
            line_items: [{
                price_data: {
                    currency: "usd",
                    product_data: { name: "CheapChat Credits" },
                    unit_amount: amountInCents,
                },
                quantity: 1,
            }],
            success_url: `https://cheap.chat/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://cheap.chat/cancel`,
            metadata: { userId }
        });

        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "https://cheap.chat, http://localhost:3000", // ✅ Restricted CORS
                "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                "Access-Control-Allow-Headers": "Content-Type, Authorization"
            },
            body: JSON.stringify({ id: session.id })
        };
    } catch (error) {
        console.error("Error processing payment:", error);

        return {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Origin": "https://cheap.chat, http://localhost:3000", // ✅ Restricted CORS
                "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
                "Access-Control-Allow-Headers": "Content-Type, Authorization"
            },
            body: JSON.stringify({ error: error.message })
        };
    }
};
