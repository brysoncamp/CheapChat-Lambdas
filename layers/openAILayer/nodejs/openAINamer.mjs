import { getOpenAIKey } from "/opt/nodejs/openAIKey.mjs";
import { getOpenAIResponseNoStream } from "/opt/nodejs/openAIHelper.mjs";
import { calculateCost } from "/opt/nodejs/openAICost.mjs";

export const generateName = async (message) => {
    console.log("Generating name for conversation based on message:", message);

    const apiKey = await getOpenAIKey();

    const messages = [
        { role: "system", content: "Generate a title for a conversation based on the following message in 3 or 4 words. Avoid unnecessary punctuation." },
        { role: "user", content: message },
    ];

    const response = await getOpenAIResponseNoStream(apiKey, "gpt-4o-mini", messages);
    console.log("OpenAI Message:", response.choices[0].message);
    
    const name = response.choices[0].message.content;
    const cost = calculateCost(response.usage.prompt_tokens, response.usage.completion_tokens, "gpt-4o-mini");
    
    return { name, cost };
}