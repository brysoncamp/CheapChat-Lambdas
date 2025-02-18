import { getOpenAIKey } from "/opt/nodejs/openAIKey.mjs";
import { getOpenAIResponseNoStream } from "/opt/nodejs/openAIHelper.mjs";

export const generateName = async (message) => {
    console.log("Generating name for conversation based on message:", message);

    const apiKey = await getOpenAIKey();

    const messages = [
        { role: "system", content: "Generate a title for a conversation based on the following message in 6 words or less." },
        { role: "user", content: message },
    ];

    const response = await getOpenAIResponseNoStream(apiKey, "gpt-4o-mini", messages);


    console.log("OpenAI Response:", response);
    //const text = response.choices[0].text;
    return response;
}