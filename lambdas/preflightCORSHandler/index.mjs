export const handler = async (event) => {
    const allowedOrigins = ["http://localhost:3000", "https://cheap.chat"];
    const requestOrigin = event.headers?.origin || ""; 
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "https://cheap.chat"; 

    const response = {
        statusCode: 200,
        headers: {
            "Access-Control-Allow-Origin": allowOrigin,
            "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
        },
        body: JSON.stringify({ message: "CORS Preflight successful" })
    };

    return response;
};